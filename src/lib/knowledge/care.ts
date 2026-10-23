import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    CARE_RECORD_LIMIT,
    conflictingCareCorrections,
    conflictingCareFacts,
    thinCareRecords,
} from "@/db/queries/almanac-care";
import {
    lockCareRecords,
    shareRecordHasOtherSources,
    shareRecordWasMerged,
} from "@/db/queries/almanac-share";
import {
    almanacDuplicateDismissals,
    knowledgeAliases,
    knowledgeEntities,
    knowledgeFacts,
    knowledgeRelationTypes,
    people,
    transcriptCorrections,
} from "@/db/schema";
import { decryptText, encryptJsonField } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { requireCareCurator } from "@/lib/knowledge/care-access";
import {
    type CareProblem,
    type CareProblemKind,
    type CareProblemPage,
    type CareRecord,
    careProblemContent,
} from "@/lib/knowledge/care-types";
import { deleteEntityInTx } from "@/lib/knowledge/entities";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import {
    lockOrgPeople,
    lockRecordingsNaming,
} from "@/lib/knowledge/org-people";
import { deletePersonInTx } from "@/lib/knowledge/people";
import {
    bumpScopeInTx,
    readScopeGenerations,
} from "@/lib/knowledge/scope-generation";
import { shareFingerprint } from "@/lib/knowledge/share-provenance";

type Executor = Pick<typeof db, "select" | "execute">;

const THIN_IDLE_MS = 120 * 86400000;

/** Read a bounded Organization scan in batches, with no per-record database lookups. */
export async function detectCareProblems(
    scope: string,
    executor: Executor = db,
): Promise<CareProblem[]> {
    const [factGroups, correctionGroups, thin] = await Promise.all([
        conflictingCareFacts(scope, executor),
        conflictingCareCorrections(scope, executor),
        thinCareRecords(scope, new Date(Date.now() - THIN_IDLE_MS), executor),
    ]);
    const factIds = factGroups.flatMap((group) => group.ids);
    const aliasIds = correctionGroups.flatMap((group) => group.ids);
    const [facts, aliases] = await Promise.all([
        factIds.length
            ? executor
                  .select()
                  .from(knowledgeFacts)
                  .where(
                      and(
                          eq(knowledgeFacts.userId, scope),
                          inArray(knowledgeFacts.id, factIds),
                      ),
                  )
                  .orderBy(knowledgeFacts.id)
            : [],
        aliasIds.length
            ? executor
                  .select()
                  .from(knowledgeAliases)
                  .where(
                      and(
                          eq(knowledgeAliases.userId, scope),
                          inArray(knowledgeAliases.id, aliasIds),
                      ),
                  )
                  .orderBy(knowledgeAliases.id)
            : [],
    ]);
    const personIds = [
        ...new Set(
            [
                ...facts.flatMap((f) => [f.subjectPersonId, f.objectPersonId]),
                ...aliases.map((a) => a.personId),
                ...thin.filter((r) => r.kind === "person").map((r) => r.id),
            ].filter((id): id is string => Boolean(id)),
        ),
    ];
    const entityIds = [
        ...new Set(
            [
                ...facts.flatMap((f) => [f.subjectEntityId, f.objectEntityId]),
                ...aliases.map((a) => a.entityId),
                ...thin.filter((r) => r.kind === "entity").map((r) => r.id),
            ].filter((id): id is string => Boolean(id)),
        ),
    ];
    const relationKeys = [
        ...new Set(factGroups.map((group) => group.relation_key)),
    ];
    const [persons, entities, relations] = await Promise.all([
        personIds.length
            ? executor
                  .select()
                  .from(people)
                  .where(
                      and(
                          eq(people.userId, scope),
                          inArray(people.id, personIds),
                          isNull(people.mergedIntoId),
                      ),
                  )
            : [],
        entityIds.length
            ? executor
                  .select()
                  .from(knowledgeEntities)
                  .where(
                      and(
                          eq(knowledgeEntities.userId, scope),
                          inArray(knowledgeEntities.id, entityIds),
                          isNull(knowledgeEntities.mergedIntoId),
                      ),
                  )
            : [],
        relationKeys.length
            ? executor
                  .select()
                  .from(knowledgeRelationTypes)
                  .where(
                      and(
                          inArray(knowledgeRelationTypes.key, relationKeys),
                          or(
                              isNull(knowledgeRelationTypes.userId),
                              eq(knowledgeRelationTypes.userId, scope),
                          ),
                      ),
                  )
            : [],
    ]);
    const records = new Map<string, CareRecord>([
        ...persons.map((row): [string, CareRecord] => [
            `p:${row.id}`,
            { id: row.id, kind: "person", name: decryptText(row.displayName) },
        ]),
        ...entities.map((row): [string, CareRecord] => [
            `e:${row.id}`,
            { id: row.id, kind: "entity", name: decryptText(row.name) },
        ]),
    ]);
    const factMap = new Map(facts.map((row) => [row.id, row]));
    const aliasMap = new Map(aliases.map((row) => [row.id, row]));
    const problems: CareProblem[] = [];
    for (const group of factGroups) {
        const subject = records.get(group.subject_key);
        if (!subject) continue;
        const rows = group.ids.flatMap((id) => {
            const row = factMap.get(id);
            return row ? [row] : [];
        });
        const options = rows.flatMap((fact) => {
            const object = records.get(fact.objectKey);
            return fact.objectLiteral || object
                ? [
                      {
                          id: fact.id,
                          label: fact.objectLiteral
                              ? decryptText(fact.objectLiteral)
                              : (object?.name ?? ""),
                      },
                  ]
                : [];
        });
        if (options.length < 2) continue;
        const relation = relations.find((r) => r.key === group.relation_key);
        problems.push({
            kind: "fact_conflict",
            key: shareFingerprint({ kind: "fact_conflict", facts: rows }),
            records: [subject],
            relationKey: group.relation_key,
            relationLabel: relation
                ? decryptText(relation.label)
                : group.relation_key,
            options,
        });
    }
    for (const group of correctionGroups) {
        const rows = group.ids.flatMap((id) => {
            const row = aliasMap.get(id);
            return row ? [row] : [];
        });
        const targets = new Map<string, CareRecord>();
        for (const row of rows) {
            const key = row.personId
                ? `p:${row.personId}`
                : `e:${row.entityId}`;
            const target = records.get(key);
            if (target) targets.set(key, target);
        }
        if (targets.size < 2 || !rows[0]) continue;
        problems.push({
            kind: "correction_conflict",
            key: shareFingerprint({
                kind: "correction_conflict",
                aliases: rows,
            }),
            heard: decryptText(rows[0].text),
            records: [...targets.values()],
            options: [...targets.values()].map((target) => ({
                id: `${target.kind}:${target.id}`,
                targetId: target.id,
                label: target.name,
            })),
        });
    }
    for (const row of thin) {
        const target = records.get(
            `${row.kind === "person" ? "p" : "e"}:${row.id}`,
        );
        if (!target) continue;
        const state =
            row.kind === "person"
                ? persons.find((p) => p.id === row.id)
                : entities.find((e) => e.id === row.id);
        problems.push({
            kind: "thin",
            key: shareFingerprint({
                kind: "thin",
                state,
                lastAt: new Date(row.last_at).toISOString(),
            }),
            records: [target],
            options: [],
            lastAt: new Date(row.last_at).toISOString(),
        });
    }
    return problems;
}

const scans = new Map<
    string,
    {
        generation: number;
        expires: number;
        problems: CareProblem[];
        timer: ReturnType<typeof setTimeout>;
    }
>();
const flights = new Map<string, Promise<CareProblem[]>>();
async function scan(scope: string) {
    const generation =
        (await readScopeGenerations(db, [scope])).get(scope) ?? 0;
    const cached = scans.get(scope);
    if (
        cached &&
        cached.generation === generation &&
        cached.expires > Date.now()
    )
        return cached.problems;
    const key = `${scope}:${generation}`;
    const pending = flights.get(key);
    if (pending) return pending;
    const promise = detectCareProblems(scope).then(async (problems) => {
        if (
            (await readScopeGenerations(db, [scope])).get(scope) === generation
        ) {
            if (cached) clearTimeout(cached.timer);
            if (scans.size >= 4) {
                const oldest = scans.keys().next().value ?? "";
                const entry = scans.get(oldest);
                if (entry) clearTimeout(entry.timer);
                scans.delete(oldest);
            }
            const timer = setTimeout(() => scans.delete(scope), 300000);
            timer.unref();
            scans.set(scope, {
                generation,
                expires: Date.now() + 300000,
                problems,
                timer,
            });
        }
        return problems;
    });
    flights.set(key, promise);
    try {
        return await promise;
    } finally {
        flights.delete(key);
    }
}

/** Current open problems, with dismissals read afresh across processes. */
export async function openCareProblems(
    actorId: string,
): Promise<CareProblem[]> {
    const scope = await requireCareCurator(actorId);
    const problems = await scan(scope);
    if (!problems.length) return [];
    const dismissed = await db
        .select({ key: almanacDuplicateDismissals.problemKey })
        .from(almanacDuplicateDismissals)
        .where(
            and(
                eq(almanacDuplicateDismissals.userId, scope),
                sql`${almanacDuplicateDismissals.problemKey} = any(${sql.param(problems.map((problem) => problem.key))}::text[])`,
            ),
        );
    const keys = new Set(dismissed.map((row) => row.key));
    return problems.filter((problem) => !keys.has(problem.key));
}

/** Page the bounded scan and report all open kinds for the queue navigation. */
export async function listCareProblems(
    actorId: string,
    kind: CareProblemKind = "fact_conflict",
    offset = 0,
): Promise<CareProblemPage> {
    const problems = await openCareProblems(actorId);
    const selected = problems.filter((problem) => problem.kind === kind);
    return {
        problems: selected.slice(offset, offset + 20),
        nextOffset: selected.length > offset + 20 ? offset + 20 : null,
        counts: {
            fact_conflict: problems.filter((p) => p.kind === "fact_conflict")
                .length,
            correction_conflict: problems.filter(
                (p) => p.kind === "correction_conflict",
            ).length,
            thin: problems.filter((p) => p.kind === "thin").length,
        },
        limited: true,
    };
}

/** Resolve or dismiss exactly the problem the curator saw, under the shared writer lock. */
export async function fixCareProblem(
    actorId: string,
    key: string,
    action: "dismiss" | "keep" | "delete",
    optionId?: string,
): Promise<void> {
    const scope = await requireCareCurator(actorId);
    await db.transaction(async (tx) => {
        await lockOrgPeople(tx);
        await requireCareCurator(actorId);
        const problem = (await detectCareProblems(scope, tx)).find(
            (p) => p.key === key,
        );
        if (!problem)
            throw new AppError(
                ErrorCode.CONFLICT,
                "The problem changed; reload",
                409,
            );
        const scopes = new Set([scope]);
        if (action === "dismiss") {
            await tx
                .insert(almanacDuplicateDismissals)
                .values({
                    userId: scope,
                    kind: problem.kind,
                    problemKey: problem.key,
                    problemData: encryptJsonField(careProblemContent(problem)),
                    dismissedByUserId: actorId,
                })
                .onConflictDoNothing();
        } else if (problem.kind === "thin" && action === "delete") {
            const target = problem.records[0];
            if (!target)
                throw new AppError(
                    ErrorCode.CONFLICT,
                    "The problem changed; reload",
                    409,
                );
            await lockRecordingsNaming(tx, {
                personIds: target.kind === "person" ? [target.id] : [],
                entityIds: target.kind === "entity" ? [target.id] : [],
            });
            await lockCareRecords(
                tx,
                scope,
                target.kind === "person" ? [target.id] : [],
                target.kind === "entity" ? [target.id] : [],
            );
            const current = (
                await thinCareRecords(
                    scope,
                    new Date(Date.now() - THIN_IDLE_MS),
                    tx,
                )
            ).find((row) => row.id === target.id && row.kind === target.kind);
            if (
                !current ||
                (await shareRecordWasMerged(
                    tx,
                    scope,
                    target.kind,
                    target.id,
                )) ||
                (await shareRecordHasOtherSources(tx, {
                    scope,
                    kind: target.kind,
                    id: target.id,
                    itemId: current.item_id,
                    since: new Date(),
                    facts: [],
                    corrections: [],
                    aliases: [],
                    emails: [],
                    allowOrganizationForms: true,
                }))
            )
                throw new AppError(
                    ErrorCode.CONFLICT,
                    "Record kept: other dependencies",
                    409,
                );
            if (target.kind === "person")
                for (const s of await deletePersonInTx(tx, actorId, target.id))
                    scopes.add(s);
            else
                for (const s of await deleteEntityInTx(tx, actorId, target.id))
                    scopes.add(s);
        } else if (problem.kind === "fact_conflict" && action === "keep") {
            if (!problem.options.some((option) => option.id === optionId))
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "Choose a current value",
                    400,
                );
            const subject = problem.records[0];
            const ids =
                subject && problem.relationKey
                    ? (
                          await tx
                              .select({ id: knowledgeFacts.id })
                              .from(knowledgeFacts)
                              .where(
                                  and(
                                      eq(knowledgeFacts.userId, scope),
                                      eq(
                                          knowledgeFacts.subjectKey,
                                          `${subject.kind === "person" ? "p" : "e"}:${subject.id}`,
                                      ),
                                      eq(
                                          knowledgeFacts.relationKey,
                                          problem.relationKey,
                                      ),
                                      isNull(knowledgeFacts.replacedByFactId),
                                  ),
                              )
                      ).map((row) => row.id)
                    : [];
            await lockRecordingsNaming(tx, { factIds: ids });
            await tx
                .update(knowledgeFacts)
                .set({ replacedByFactId: optionId, updatedAt: new Date() })
                .where(
                    and(
                        eq(knowledgeFacts.userId, scope),
                        inArray(knowledgeFacts.id, ids),
                        ne(knowledgeFacts.id, optionId ?? ""),
                    ),
                );
        } else if (
            problem.kind === "correction_conflict" &&
            action === "keep"
        ) {
            const chosen = problem.options.find(
                (option) => option.id === optionId,
            );
            if (!chosen)
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "Choose a correction target",
                    400,
                );
            const targets = problem.records;
            await lockRecordingsNaming(tx, {
                personIds: targets
                    .filter((r) => r.kind === "person")
                    .map((r) => r.id),
                entityIds: targets
                    .filter((r) => r.kind === "entity")
                    .map((r) => r.id),
            });
            const aliases = await tx
                .select()
                .from(knowledgeAliases)
                .where(
                    and(
                        eq(knowledgeAliases.userId, scope),
                        eq(knowledgeAliases.kind, "heard_as"),
                        eq(
                            knowledgeAliases.textHmac,
                            domainLookupHash("alias", problem.heard ?? ""),
                        ),
                    ),
                );
            const losing = aliases.filter(
                (row) => (row.personId ?? row.entityId) !== chosen.targetId,
            );
            const ids = losing.flatMap((row) =>
                row.correctionId ? [row.correctionId] : [],
            );
            if (ids.length) {
                const [privateAlias] = await tx
                    .select({ id: knowledgeAliases.id })
                    .from(knowledgeAliases)
                    .where(
                        and(
                            inArray(knowledgeAliases.correctionId, ids),
                            ne(knowledgeAliases.userId, scope),
                        ),
                    )
                    .limit(1);
                if (privateAlias)
                    throw new AppError(
                        ErrorCode.CONFLICT,
                        "Correction kept: other dependencies",
                        409,
                    );
            }
            if (ids.length)
                await tx
                    .delete(transcriptCorrections)
                    .where(
                        and(
                            eq(transcriptCorrections.userId, scope),
                            inArray(transcriptCorrections.id, ids),
                        ),
                    );
        } else
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "Invalid Care action",
                400,
            );
        await bumpScopeInTx(tx, scopes);
    });
}

export { CARE_RECORD_LIMIT };
