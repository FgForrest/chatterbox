/**
 * Importing a pasted list into the Almanac: one line per type, the names
 * after a colon, nicknames in parentheses.
 *
 *     product: Alpha, Beta (Béta, B2)
 *     organization: Acme
 *     person: Jana Nováková (Janička)
 *
 * A preview first says what each name would do (be created, add its
 * nicknames to a record that exists, or nothing, and why); applying does
 * it in one transaction. A type is never created by an import: an unknown
 * one sends the person to the vocabulary.
 */

import { and, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { people as peopleTable } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { addAliasInTx, MAX_ALIAS_LENGTH } from "@/lib/knowledge/aliases";
import {
    createEntityInTx,
    findEntityByNameInTx,
    MAX_ENTITY_NAME_LENGTH,
} from "@/lib/knowledge/entities";
import {
    type ParseProblem,
    parseImportList,
    resolveImportType,
} from "@/lib/knowledge/import-list-parse";
import { normalizeLabelForLookup } from "@/lib/knowledge/lookup-hash";
import { lockOrgPeople, lockOrgPeopleShared } from "@/lib/knowledge/org-people";
import {
    createPersonInTx,
    MAX_DISPLAY_NAME_LENGTH,
    peopleVisibleTo,
} from "@/lib/knowledge/people";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import { vocabularyVisibleTo } from "@/lib/knowledge/vocabulary";
import { getOrgUserId } from "@/lib/org/config";

export const MAX_IMPORT_RECORDS = 500;
export const MAX_IMPORT_NICKNAMES = 2000;
export const MAX_IMPORT_BYTES = 100 * 1024;
const MAX_NICKNAMES = 20;

export type ImportRowStatus =
    | "create"
    | "exists"
    | "unknown_type"
    | "invalid"
    /** Several people have this name: nicknames go on their own pages. */
    | "ambiguous";

export interface ImportRow {
    line: number;
    name: string;
    /** The type key, or null where the list's type is unknown. */
    typeKey: string | null;
    typeText: string;
    nicknames: string[];
    status: ImportRowStatus;
    /** Where it exists already or was created. */
    recordId?: string;
    kind?: "person" | "entity";
}

export interface ImportResult {
    rows: ImportRow[];
    problems: ParseProblem[];
    created: number;
    /** Nicknames given, to new and existing records. */
    nicknamesAdded: number;
    applied: boolean;
}

function tooMany(): AppError {
    return new AppError(
        ErrorCode.INVALID_INPUT,
        `At most ${MAX_IMPORT_RECORDS} names and ${MAX_IMPORT_NICKNAMES} nicknames can be imported at once`,
        400,
        {
            field: "text",
            maxRecords: MAX_IMPORT_RECORDS,
            maxNicknames: MAX_IMPORT_NICKNAMES,
        },
    );
}

/** A name as its lookup hash compares it: case and spacing aside. */
function nameKey(name: string): string {
    return normalizeLabelForLookup(name);
}

/**
 * Preview (`dryRun`) or apply an import into `actorUserId`'s own scope:
 * theirs, or the Organization's for its account. A name that exists among
 * the records they see (their own, then the Organization's) is not created
 * again; its new nicknames are added in their scope.
 */
export async function importList(
    actorUserId: string,
    text: string,
    { dryRun }: { dryRun: boolean },
): Promise<ImportResult> {
    const { names, problems } = parseImportList(text);
    if (names.length > MAX_IMPORT_RECORDS) throw tooMany();
    const vocabulary = await vocabularyVisibleTo(actorUserId);
    const types = [
        { key: "person", label: "Person" },
        ...vocabulary.entityTypes
            .filter((type) => type.key !== "person" && !type.adoptedAsKey)
            .map((type) => ({ key: type.key, label: type.label })),
    ];
    const orgUserId = await getOrgUserId();

    const nicknames = names.reduce(
        (sum, name) => sum + name.nicknames.length,
        0,
    );
    if (nicknames > MAX_IMPORT_NICKNAMES) throw tooMany();

    return db.transaction(async (tx) => {
        // A preview writes nothing, so it waits for nobody. Writing the
        // Organization's takes its lock whole, as creating one thing does;
        // an account's own scope only keeps a share from running meanwhile.
        if (!dryRun) {
            if (actorUserId === orgUserId) await lockOrgPeople(tx);
            else await lockOrgPeopleShared(tx);
            // One import into a scope at a time: two at once would both
            // find a name missing, and people have no unique name.
            await tx.execute(
                sql`select pg_advisory_xact_lock(hashtext(${`riffado:import:${actorUserId}`}))`,
            );
        }
        // The people the actor sees, by name: names have no lookup hash,
        // so they are compared decrypted. Two of one name are ambiguous.
        const personByName = new Map<string, string[]>();
        const people = await tx
            .select({ id: peopleTable.id, name: peopleTable.displayName })
            .from(peopleTable)
            .where(
                and(
                    peopleVisibleTo(actorUserId),
                    isNull(peopleTable.mergedIntoId),
                ),
            );
        for (const person of people) {
            const key = nameKey(decryptText(person.name));
            personByName.set(key, [
                ...(personByName.get(key) ?? []),
                person.id,
            ]);
        }

        const rows: ImportRow[] = [];
        // A name listed twice is created once.
        const listed = new Set<string>();
        let created = 0;
        let nicknamesAdded = 0;
        for (const parsed of names) {
            const typeKey = resolveImportType(parsed.typeText, types);
            const row: ImportRow = {
                line: parsed.line,
                name: parsed.name,
                typeKey,
                typeText: parsed.typeText,
                nicknames: parsed.nicknames,
                status: "create",
            };
            rows.push(row);
            if (!typeKey) {
                row.status = "unknown_type";
                continue;
            }
            const maxName =
                typeKey === "person"
                    ? MAX_DISPLAY_NAME_LENGTH
                    : MAX_ENTITY_NAME_LENGTH;
            if (
                parsed.name.length > maxName ||
                parsed.nicknames.length > MAX_NICKNAMES ||
                parsed.nicknames.some(
                    (nickname) => nickname.length > MAX_ALIAS_LENGTH,
                )
            ) {
                row.status = "invalid";
                continue;
            }
            row.kind = typeKey === "person" ? "person" : "entity";
            const listedKey = `${typeKey}|${nameKey(parsed.name)}`;
            const listedBefore = listed.has(listedKey);
            listed.add(listedKey);
            let existing: string | null;
            if (row.kind === "person") {
                const matches = personByName.get(nameKey(parsed.name)) ?? [];
                if (matches.length > 1) {
                    row.status = "ambiguous";
                    continue;
                }
                existing = matches[0] ?? null;
            } else {
                existing =
                    (await findEntityByNameInTx(
                        tx,
                        actorUserId,
                        typeKey,
                        parsed.name,
                    )) ??
                    (orgUserId && orgUserId !== actorUserId
                        ? await findEntityByNameInTx(
                              tx,
                              orgUserId,
                              typeKey,
                              parsed.name,
                          )
                        : null);
            }
            if (existing) {
                row.status = "exists";
                row.recordId = existing;
            } else if (listedBefore && dryRun) {
                // Created by the line before it, once applied.
                row.status = "exists";
            }
            if (dryRun) continue;

            if (!existing) {
                if (row.kind === "person") {
                    const person = await createPersonInTx(tx, {
                        userId: actorUserId,
                        displayName: parsed.name,
                    });
                    row.recordId = person.id;
                    personByName.set(nameKey(parsed.name), [person.id]);
                } else {
                    row.recordId = await createEntityInTx(tx, actorUserId, {
                        typeKey,
                        name: parsed.name,
                    });
                }
                created++;
            }
            const target =
                row.kind === "person"
                    ? { personId: row.recordId as string }
                    : { entityId: row.recordId as string };
            for (const nickname of parsed.nicknames) {
                if (await addAliasInTx(tx, actorUserId, target, nickname)) {
                    nicknamesAdded++;
                }
            }
        }
        if (!dryRun && (created > 0 || nicknamesAdded > 0)) {
            await bumpScopeInTx(tx, [actorUserId]);
        }
        return {
            rows,
            problems,
            created,
            nicknamesAdded,
            applied: !dryRun,
        };
    });
}
