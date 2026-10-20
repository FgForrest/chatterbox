import {
    type AnyColumn,
    and,
    asc,
    eq,
    exists,
    gte,
    inArray,
    isNull,
    lt,
    lte,
    notInArray,
    or,
    type SQL,
    sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    chatterItems,
    knowledgeFactEvidence,
    knowledgeFacts,
    mailContents,
    mailMessages,
    mailParticipants,
    people,
    personEmails,
} from "@/db/schema";
import type { ContentSegment } from "@/lib/content/types";
import { keysetBefore, keysetOrder } from "@/lib/db/keyset";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import { folderRecordingCondition } from "@/lib/folders/condition";
import { readableScopes } from "@/lib/knowledge/scope";
import { participantAddressHash } from "@/lib/mail/hash";
import { isInternalMailAddress } from "@/lib/mail/internal-address";
import type { AttachmentMeta } from "@/lib/mail/parse";
import { secretAddressMasker } from "@/lib/mail/redact";
import { searchableMailParts } from "@/lib/mail/searchable-parts";
import type { McpCaller } from "@/lib/mcp/caller";
import { encodeKeyset, parseKeyset } from "@/lib/mcp/cursor";
import {
    callerFolderOrganization,
    type RecordingFilters,
} from "@/lib/mcp/data/recordings";
import { McpToolError } from "@/lib/mcp/errors";
import { recordingUrl } from "@/lib/mcp/links";
import {
    knowledgeContextFor,
    mcpItemCondition,
    recordingViewFor,
} from "@/lib/mcp/scope";
import {
    type StoredSummary,
    storedSummaryOf,
} from "@/lib/summary/read-summary";

interface MailPersonFilter {
    id: string;
    hashes: readonly string[];
}

async function personCondition(
    caller: McpCaller,
    personId: string,
): Promise<{ condition: SQL; person: MailPersonFilter }> {
    const scopes = readableScopes(
        knowledgeContextFor(caller),
        caller.orgUserId,
    );
    const [primary, additional, linked] = await Promise.all([
        db
            .select({ email: people.primaryEmail })
            .from(people)
            .where(
                and(eq(people.id, personId), inArray(people.userId, scopes)),
            ),
        db
            .select({ email: personEmails.email })
            .from(personEmails)
            .where(
                and(
                    eq(personEmails.personId, personId),
                    inArray(personEmails.userId, scopes),
                ),
            ),
        db
            .selectDistinctOn([mailParticipants.addressHash], {
                email: mailParticipants.address,
            })
            .from(mailParticipants)
            .innerJoin(
                chatterItems,
                and(
                    eq(chatterItems.id, mailParticipants.itemId),
                    eq(chatterItems.userId, mailParticipants.userId),
                ),
            )
            .where(
                and(
                    eq(mailParticipants.personId, personId),
                    mcpItemCondition(caller, ["mail"]),
                ),
            ),
    ]);
    const addresses = [...primary, ...additional].flatMap((row) =>
        row.email ? [decryptText(row.email)] : [],
    );
    const mask = await secretAddressMasker(addresses);
    const hashes = addresses
        .filter(
            (address) =>
                !isInternalMailAddress(address) && mask(address) === address,
        )
        .map(participantAddressHash);
    const secrets = [
        ...new Set([
            ...addresses.filter(
                (address) =>
                    isInternalMailAddress(address) || mask(address) !== address,
            ),
            ...linked
                .flatMap((row) => (row.email ? [decryptText(row.email)] : []))
                .filter(isInternalMailAddress),
        ]),
    ].map(participantAddressHash);
    const condition = exists(
        db
            .select({ one: sql`1` })
            .from(mailParticipants)
            .where(
                and(
                    eq(mailParticipants.itemId, chatterItems.id),
                    eq(mailParticipants.userId, chatterItems.userId),
                    or(
                        eq(mailParticipants.personId, personId),
                        hashes.length
                            ? inArray(mailParticipants.addressHash, hashes)
                            : undefined,
                    ),
                    secrets.length
                        ? or(
                              isNull(mailParticipants.addressHash),
                              notInArray(mailParticipants.addressHash, secrets),
                          )
                        : undefined,
                ),
            ),
    );
    return { condition, person: { id: personId, hashes } };
}

function entityCondition(caller: McpCaller, entityId: string): SQL {
    return exists(
        db
            .select({ one: sql`1` })
            .from(knowledgeFactEvidence)
            .innerJoin(
                knowledgeFacts,
                and(
                    eq(knowledgeFacts.id, knowledgeFactEvidence.factId),
                    eq(knowledgeFacts.userId, knowledgeFactEvidence.userId),
                ),
            )
            .where(
                and(
                    eq(knowledgeFactEvidence.itemId, chatterItems.id),
                    eq(knowledgeFactEvidence.status, "supported"),
                    inArray(
                        knowledgeFacts.userId,
                        readableScopes(
                            knowledgeContextFor(caller),
                            caller.orgUserId,
                        ),
                    ),
                    or(
                        eq(knowledgeFacts.subjectEntityId, entityId),
                        eq(knowledgeFacts.objectEntityId, entityId),
                    ),
                ),
            ),
    );
}

/** Mail filters only narrow the caller's visible pile. */
export async function mailFilterConditions(
    caller: McpCaller,
    filters: RecordingFilters,
): Promise<{ where: SQL; person: MailPersonFilter | null }> {
    const conditions: (SQL | undefined)[] = [
        mcpItemCondition(caller, ["mail"]),
    ];
    if (filters.from)
        conditions.push(gte(chatterItems.occurredAt, filters.from));
    if (filters.to)
        conditions.push(
            filters.to.inclusive
                ? lte(chatterItems.occurredAt, filters.to.at)
                : lt(chatterItems.occurredAt, filters.to.at),
        );
    if (filters.folderId) {
        const folder = folderRecordingCondition(
            await callerFolderOrganization(caller),
            caller.kind === "user" ? caller.userId : caller.orgUserId,
            filters.folderId,
            { id: chatterItems.id, userId: chatterItems.userId },
        );
        if (!folder) throw new McpToolError("No such folder", "not_found");
        conditions.push(folder);
    }
    const person = filters.personId
        ? await personCondition(caller, filters.personId)
        : null;
    if (person) conditions.push(person.condition);
    if (filters.entityId && caller.roles.has("knowledge:read"))
        conditions.push(entityCondition(caller, filters.entityId));
    return { where: and(...conditions) as SQL, person: person?.person ?? null };
}

/** A batch of mail in list_mail order, with owner-keyed headers. */
export function mailSearchBatch(where: SQL, before: string | null) {
    const after = parseKeyset(before);
    return db
        .select({
            id: chatterItems.id,
            userId: chatterItems.userId,
            title: chatterItems.title,
            occurredAt: chatterItems.occurredAt,
            sentAt: mailMessages.sentAt,
            receivedAt: mailMessages.receivedAt,
            senderVerified: mailMessages.senderVerified,
            attachments: mailMessages.attachments,
        })
        .from(chatterItems)
        .innerJoin(
            mailMessages,
            and(
                eq(mailMessages.id, chatterItems.id),
                eq(mailMessages.userId, chatterItems.userId),
            ),
        )
        .where(
            and(
                where,
                after
                    ? keysetBefore(
                          chatterItems.occurredAt,
                          chatterItems.id,
                          after,
                      )
                    : undefined,
            ),
        )
        .orderBy(...keysetOrder(chatterItems.occurredAt, chatterItems.id))
        .limit(50);
}

type MailRow = Awaited<ReturnType<typeof mailSearchBatch>>[number];

/** The cursor continuing after a mail in newest-first order. */
export function mailSearchStamp(row: MailRow): string {
    return encodeKeyset({ at: row.occurredAt, id: row.id });
}

/** A masked searchable part, with the quoted writer's claimed name or address. */
export interface MailSearchPart {
    part: "subject" | "from" | "body" | "quoted" | "summary";
    author: string | null;
    text: string;
}

/** Decrypted mail data for matching and returning a list_mail row. */
export interface SearchableMail {
    mail: {
        id: string;
        kind: "mail";
        untrusted: true;
        subject: string;
        from: { name: string | null; address: string } | null;
        sent_at: string | null;
        received_at: string;
        sender_verified: boolean;
        attachments: number;
        url: string;
    };
    language: string | null;
    parts: MailSearchPart[];
}

/** Owner-keyed content, participants and optional summaries, masked before matching. */
export async function searchableMailBatch(
    caller: McpCaller,
    rows: readonly MailRow[],
    candidateCondition: SQL,
    personFilter: MailPersonFilter | null = null,
): Promise<Map<string, SearchableMail>> {
    if (!rows.length) return new Map();
    const ownerCondition = (itemId: AnyColumn, userId: AnyColumn) =>
        or(
            ...rows.map((row) =>
                and(eq(itemId, row.id), eq(userId, row.userId)),
            ),
        );
    const [contents, participants, enhancements] = await Promise.all([
        db
            .select()
            .from(mailContents)
            .where(ownerCondition(mailContents.itemId, mailContents.userId)),
        db
            .select()
            .from(mailParticipants)
            .where(
                ownerCondition(
                    mailParticipants.itemId,
                    mailParticipants.userId,
                ),
            )
            .orderBy(asc(mailParticipants.position)),
        caller.roles.has("summaries:read")
            ? db
                  .select()
                  .from(aiEnhancements)
                  .where(
                      ownerCondition(
                          aiEnhancements.itemId,
                          aiEnhancements.userId,
                      ),
                  )
            : Promise.resolve([]),
    ]);
    const segments = new Map(
        contents.map((row) => [
            row.itemId,
            decryptJsonField<ContentSegment[]>(row.segments) ?? [],
        ]),
    );
    const originalConditions = rows.flatMap((row) => {
        const ids = [
            ...new Set(
                (segments.get(row.id) ?? []).flatMap((part) =>
                    part.knownItemId ? [part.knownItemId] : [],
                ),
            ),
        ];
        return ids.length
            ? [
                  and(
                      eq(chatterItems.userId, row.userId),
                      inArray(chatterItems.id, ids),
                  ),
              ]
            : [];
    });
    const originals = originalConditions.length
        ? await db
              .select({ id: chatterItems.id })
              .from(chatterItems)
              .where(and(or(...originalConditions), candidateCondition))
        : [];
    const candidates = new Set(originals.map((row) => row.id));
    const stored = new Map<string, StoredSummary>();
    for (const enhancement of enhancements) {
        if (stored.has(enhancement.itemId) && enhancement.source !== "riffado")
            continue;
        stored.set(enhancement.itemId, storedSummaryOf(enhancement));
    }
    const mails = new Map<string, SearchableMail>();
    const personAddresses = new Map<string, (string | null)[]>();
    for (const row of rows) {
        const people = participants
            .filter((person) => person.itemId === row.id)
            .map((person) => ({
                ref: person.ref,
                personId: person.personId,
                addressHash: person.addressHash,
                roles: person.roles,
                name: person.name ? decryptText(person.name) : null,
                address: person.address ? decryptText(person.address) : null,
            }));
        if (personFilter) {
            personAddresses.set(
                row.id,
                people
                    .filter(
                        (person) =>
                            person.personId === personFilter.id ||
                            (person.addressHash &&
                                personFilter.hashes.includes(
                                    person.addressHash,
                                )),
                    )
                    .map((person) => person.address),
            );
        }
        const from = people.find(
            (person) => person.roles.includes("from") && person.address,
        );
        const subject = decryptText(row.title);
        const parts: MailSearchPart[] = [
            { part: "subject", author: null, text: subject },
        ];
        if (from?.name)
            parts.push({ part: "from", author: null, text: from.name });
        if (from?.address)
            parts.push({ part: "from", author: null, text: from.address });
        for (const part of searchableMailParts(
            segments.get(row.id) ?? [],
            candidates,
        )) {
            const author = people.find(
                (person) => person.ref === part.participantRef,
            );
            parts.push({
                part: part.part,
                author:
                    part.part === "quoted"
                        ? author?.name || author?.address || null
                        : null,
                text: part.text,
            });
        }
        const summary = stored.get(row.id);
        for (const text of [summary?.summary, ...(summary?.keyPoints ?? [])]) {
            if (text) parts.push({ part: "summary", author: null, text });
        }
        mails.set(row.id, {
            mail: {
                id: row.id,
                kind: "mail",
                untrusted: true,
                subject,
                from: from?.address
                    ? { name: from.name, address: from.address }
                    : null,
                sent_at: row.sentAt?.toISOString() ?? null,
                received_at: row.receivedAt.toISOString(),
                sender_verified: row.senderVerified,
                attachments: (
                    decryptJsonField<AttachmentMeta[]>(row.attachments) ?? []
                ).length,
                url: recordingUrl(row.id, recordingViewFor(caller, row.userId)),
            },
            language:
                contents.find((content) => content.itemId === row.id)
                    ?.language ?? null,
            parts,
        });
    }
    const mask = await secretAddressMasker([
        ...[...mails.values()].flatMap((mail) =>
            mail.parts.flatMap((part) => [part.text, part.author ?? ""]),
        ),
        ...[...personAddresses.values()].flatMap((addresses) =>
            addresses.flatMap((address) => (address ? [address] : [])),
        ),
    ]);
    for (const found of mails.values()) {
        if (
            personFilter &&
            !personAddresses
                .get(found.mail.id)
                ?.some((address) => !address || mask(address) === address)
        ) {
            mails.delete(found.mail.id);
            continue;
        }
        found.mail.subject = mask(found.mail.subject);
        if (found.mail.from) {
            found.mail.from.name = found.mail.from.name
                ? mask(found.mail.from.name)
                : null;
            found.mail.from.address = mask(found.mail.from.address);
        }
        found.parts = found.parts.map((part) => ({
            ...part,
            text: mask(part.text),
            author: part.author ? mask(part.author) : null,
        }));
    }
    return mails;
}
