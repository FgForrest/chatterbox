import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { db } from "@/db";
import {
    knowledgeEntities,
    type learnReviewItems,
    type learnRuns,
    people,
} from "@/db/schema";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import { findEntityByNameInTx } from "@/lib/knowledge/entities";
import { type RecordTarget, recordNameKey } from "@/lib/learn/new-refs";
import type { ReviewChoice } from "@/lib/learn/review";
import type { NewRecordPayload } from "@/lib/learn/validate-new-records";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Run = typeof learnRuns.$inferSelect;
type ReviewRow = typeof learnReviewItems.$inferSelect;

function recordTarget(value: unknown): RecordTarget | null {
    if (!value || typeof value !== "object") return null;
    if ("personId" in value && typeof value.personId === "string") {
        return { personId: value.personId };
    }
    if ("entityId" in value && typeof value.entityId === "string") {
        return { entityId: value.entityId };
    }
    return null;
}

/** Resolve confirmed additions, reconstructing legacy applied rows within their run interval. */
export async function confirmedLearnRecordsInTx(
    tx: Tx,
    run: Run,
    rows: ReviewRow[],
    scopes: string[] = [run.userId],
): Promise<RecordTarget[]> {
    const saved = run.inputs?.confirmedRecords;
    if (Array.isArray(saved)) {
        return saved.flatMap((value) => {
            const target = recordTarget(value);
            return target ? [target] : [];
        });
    }
    const targets: RecordTarget[] = [];
    for (const row of rows) {
        if (row.kind !== "new_record" || row.outcome !== "applied") continue;
        const choice = row.choice
            ? decryptJsonField<ReviewChoice>(row.choice)
            : null;
        if (recordTarget(choice)) continue;
        const payload = decryptJsonField<NewRecordPayload>(row.payload);
        if (!payload || !run.finishedAt) continue;
        const name = choice && "name" in choice ? choice.name : payload.name;
        if (payload.kind === "entity") {
            const typeKey =
                choice && "typeKey" in choice
                    ? choice.typeKey
                    : payload.typeKey;
            for (const scope of scopes) {
                const entityId = typeKey
                    ? await findEntityByNameInTx(tx, scope, typeKey, name)
                    : null;
                if (!entityId) continue;
                const [created] = await tx
                    .select({ id: knowledgeEntities.id })
                    .from(knowledgeEntities)
                    .where(
                        and(
                            eq(knowledgeEntities.id, entityId),
                            eq(knowledgeEntities.userId, scope),
                            gte(knowledgeEntities.createdAt, run.createdAt),
                            lte(knowledgeEntities.createdAt, run.finishedAt),
                        ),
                    )
                    .limit(1);
                if (created) targets.push({ entityId: created.id });
            }
        } else {
            const candidates = await tx
                .select({ id: people.id, name: people.displayName })
                .from(people)
                .where(
                    and(
                        inArray(people.userId, scopes),
                        isNull(people.mergedIntoId),
                        gte(people.createdAt, run.createdAt),
                        lte(people.createdAt, run.finishedAt),
                    ),
                );
            const matching = candidates.filter(
                (person) =>
                    recordNameKey(decryptText(person.name)) ===
                    recordNameKey(name),
            );
            if (matching.length === 1 && matching[0]) {
                targets.push({ personId: matching[0].id });
            }
        }
    }
    return targets;
}
