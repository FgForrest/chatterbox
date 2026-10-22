import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { db } from "@/db";
import {
    knowledgeEntities,
    knowledgeFacts,
    knowledgeRelationTypes,
    people,
} from "@/db/schema";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { addAliasInTx } from "@/lib/knowledge/aliases";
import type { DuplicateKind } from "@/lib/knowledge/duplicate-score";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import { getOrgUserId } from "@/lib/org/config";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<typeof db, "select">;

export interface MergeChoices {
    nameSourceId: string;
    factChoices: Record<string, string>;
    version: string;
}

export interface MergeClash {
    relationKey: string;
    factIds: string[];
}

/** Read a current Organization comparison under the caller's merge lock when writing. */
export async function mergeState(
    executor: Reader,
    scope: string,
    kind: DuplicateKind,
    ids: string[],
) {
    const records =
        kind === "person"
            ? await executor
                  .select({
                      id: people.id,
                      name: people.displayName,
                      updatedAt: people.updatedAt,
                      email: people.primaryEmail,
                  })
                  .from(people)
                  .where(
                      and(
                          eq(people.userId, scope),
                          inArray(people.id, ids),
                          isNull(people.mergedIntoId),
                      ),
                  )
                  .orderBy(people.id)
            : await executor
                  .select({
                      id: knowledgeEntities.id,
                      name: knowledgeEntities.name,
                      updatedAt: knowledgeEntities.updatedAt,
                      typeKey: knowledgeEntities.typeKey,
                  })
                  .from(knowledgeEntities)
                  .where(
                      and(
                          eq(knowledgeEntities.userId, scope),
                          inArray(knowledgeEntities.id, ids),
                          isNull(knowledgeEntities.mergedIntoId),
                      ),
                  )
                  .orderBy(knowledgeEntities.id);
    if (ids[0] === ids[1] || records.length !== 2)
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Duplicate pair not found",
            404,
        );
    const keys = ids.map((id) => `${kind === "person" ? "p" : "e"}:${id}`);
    const facts = await executor
        .select()
        .from(knowledgeFacts)
        .where(
            and(
                eq(knowledgeFacts.userId, scope),
                isNull(knowledgeFacts.replacedByFactId),
                or(
                    inArray(knowledgeFacts.subjectKey, keys),
                    inArray(knowledgeFacts.objectKey, keys),
                ),
            ),
        )
        .orderBy(knowledgeFacts.id)
        .limit(1001);
    if (facts.length > 1000)
        throw new AppError(
            ErrorCode.CONFLICT,
            "Too many facts to compare at once",
            409,
            { reason: "too_many_facts" },
        );
    const relations = await executor
        .select({
            key: knowledgeRelationTypes.key,
            label: knowledgeRelationTypes.label,
            cardinality: knowledgeRelationTypes.cardinality,
        })
        .from(knowledgeRelationTypes)
        .where(
            and(
                inArray(knowledgeRelationTypes.key, [
                    ...new Set(facts.map((fact) => fact.relationKey)),
                ]),
                or(
                    isNull(knowledgeRelationTypes.userId),
                    eq(knowledgeRelationTypes.userId, scope),
                ),
            ),
        )
        .orderBy(
            knowledgeRelationTypes.userId,
            knowledgeRelationTypes.key,
            knowledgeRelationTypes.id,
        );
    const relationByKey = new Map(
        relations.map((relation) => [relation.key, relation]),
    );
    const groups = new Map<string, typeof facts>();
    const canonicalObject = (key: string) =>
        keys.includes(key) ? ([...keys].sort()[0] ?? key) : key;
    for (const fact of facts) {
        if (
            !keys.includes(fact.subjectKey) ||
            relationByKey.get(fact.relationKey)?.cardinality !== "one"
        )
            continue;
        const group = groups.get(fact.relationKey) ?? [];
        group.push(fact);
        groups.set(fact.relationKey, group);
    }
    const clashes: MergeClash[] = [...groups].flatMap(
        ([relationKey, values]) =>
            new Set(values.map((fact) => canonicalObject(fact.objectKey)))
                .size > 1
                ? [{ relationKey, factIds: values.map((fact) => fact.id) }]
                : [],
    );
    const version = domainLookupHash(
        "merge-comparison",
        JSON.stringify({ kind, records, facts, relations }),
    );
    return { records, facts, relations, clashes, version };
}

/** Validate explicit name and fact choices against the comparison the curator actually saw. */
export async function prepareMergeChoices(
    tx: Tx,
    actorId: string,
    scope: string,
    kind: DuplicateKind,
    ids: string[],
    choices: MergeChoices,
) {
    if (
        !(await userCuratesOrganizationNow(actorId)) ||
        (await getOrgUserId()) !== scope
    ) {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only an Organization curator can compare and join",
            403,
        );
    }
    const state = await mergeState(tx, scope, kind, ids);
    if (choices.version !== state.version)
        throw new AppError(
            ErrorCode.CONFLICT,
            "These records changed. Compare them again.",
            409,
            { reason: "stale_comparison" },
        );
    const selected = state.records.find(
        (record) => record.id === choices.nameSourceId,
    );
    if (!selected)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Choose a name from these records",
            400,
        );
    if (
        Object.keys(choices.factChoices).some(
            (key) => !state.clashes.some((clash) => clash.relationKey === key),
        )
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Unexpected fact choice",
            400,
        );
    }
    const facts = state.clashes.map((clash) => {
        const id = choices.factChoices[clash.relationKey];
        const fact = state.facts.find(
            (fact) => fact.id === id && clash.factIds.includes(fact.id),
        );
        if (!fact)
            throw new AppError(
                ErrorCode.CONFLICT,
                "Choose which value stays for every clash",
                409,
                { reason: "missing_clash_choice" },
            );
        return { relationKey: fact.relationKey, objectKey: fact.objectKey };
    });
    return {
        name: decryptText(selected.name),
        names: state.records.map((record) => decryptText(record.name)),
        facts,
    };
}

/** Apply choices after the existing merge, retaining replaced values and all of their evidence. */
export async function finishMergeChoices(
    tx: Tx,
    scope: string,
    actorId: string,
    kind: DuplicateKind,
    winnerId: string,
    loserId: string,
    prepared: Awaited<ReturnType<typeof prepareMergeChoices>>,
) {
    const target =
        kind === "person" ? { personId: winnerId } : { entityId: winnerId };
    for (const name of new Set(prepared.names)) {
        if (name === prepared.name) continue;
        await addAliasInTx(tx, scope, target, name, actorId);
    }
    const prefix = kind === "person" ? "p" : "e";
    for (const choice of prepared.facts) {
        const objectKey =
            choice.objectKey === `${prefix}:${loserId}`
                ? `${prefix}:${winnerId}`
                : choice.objectKey;
        const group = and(
            eq(knowledgeFacts.userId, scope),
            eq(knowledgeFacts.subjectKey, `${prefix}:${winnerId}`),
            eq(knowledgeFacts.relationKey, choice.relationKey),
        );
        const [kept] = await tx
            .select({ id: knowledgeFacts.id })
            .from(knowledgeFacts)
            .where(and(group, eq(knowledgeFacts.objectKey, objectKey)))
            .limit(1);
        if (!kept)
            throw new AppError(
                ErrorCode.CONFLICT,
                "The chosen fact changed",
                409,
                { reason: "chosen_fact_changed" },
            );
        await tx
            .update(knowledgeFacts)
            .set({ replacedByFactId: kept.id, updatedAt: new Date() })
            .where(
                and(
                    group,
                    ne(knowledgeFacts.id, kept.id),
                    isNull(knowledgeFacts.replacedByFactId),
                ),
            );
        await tx
            .update(knowledgeFacts)
            .set({ replacedByFactId: null, updatedAt: new Date() })
            .where(and(group, eq(knowledgeFacts.id, kept.id)));
    }
}
