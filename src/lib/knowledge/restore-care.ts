import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
    almanacDuplicateDismissals,
    knowledgeEntities,
    people,
} from "@/db/schema";
import { encryptJsonField } from "@/lib/encryption/fields";
import { detectCareProblems } from "@/lib/knowledge/care";
import { requireCareCurator } from "@/lib/knowledge/care-access";
import type { CareArchive } from "@/lib/knowledge/care-archive";
import { careProblemContent } from "@/lib/knowledge/care-types";
import { lockOrgPeople } from "@/lib/knowledge/org-people";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";

/** Restore after Organization records, usage and facts, recomputing local fingerprints and checking every target. */
export async function restoreCareArchive(
    actorId: string,
    archive: CareArchive,
    idMap: Record<string, string> = {},
): Promise<{ restored: number; skipped: number }> {
    const scope = await requireCareCurator(actorId);
    return db.transaction(async (tx) => {
        await lockOrgPeople(tx);
        await requireCareCurator(actorId);
        let restored = 0;
        let skipped = 0;
        for (const pair of archive.duplicates) {
            const ids = [
                idMap[pair.left] ?? pair.left,
                idMap[pair.right] ?? pair.right,
            ].sort();
            const table = pair.kind === "person" ? people : knowledgeEntities;
            const rows = await tx
                .select({ id: table.id })
                .from(table)
                .where(
                    and(
                        eq(table.userId, scope),
                        inArray(table.id, ids),
                        isNull(table.mergedIntoId),
                    ),
                );
            if (rows.length !== 2 || ids[0] === ids[1]) {
                skipped++;
                continue;
            }
            await tx
                .insert(almanacDuplicateDismissals)
                .values({
                    userId: scope,
                    kind: pair.kind,
                    ...(pair.kind === "person"
                        ? { leftPersonId: ids[0], rightPersonId: ids[1] }
                        : { leftEntityId: ids[0], rightEntityId: ids[1] }),
                    dismissedByUserId: actorId,
                })
                .onConflictDoNothing();
            restored++;
        }
        const current = await detectCareProblems(scope, tx);
        for (const saved of archive.problems) {
            const mapped = {
                ...saved,
                records: saved.records
                    .map((record) => ({
                        ...record,
                        id: idMap[record.id] ?? record.id,
                    }))
                    .sort((a, b) => a.id.localeCompare(b.id)),
                relationKey: saved.relationKey
                    ? (idMap[saved.relationKey] ?? saved.relationKey)
                    : null,
            };
            const match = current.find(
                (problem) =>
                    JSON.stringify(careProblemContent(problem)) ===
                    JSON.stringify(mapped),
            );
            if (!match) {
                skipped++;
                continue;
            }
            await tx
                .insert(almanacDuplicateDismissals)
                .values({
                    userId: scope,
                    kind: match.kind,
                    problemKey: match.key,
                    problemData: encryptJsonField(careProblemContent(match)),
                    dismissedByUserId: actorId,
                })
                .onConflictDoNothing();
            restored++;
        }
        await bumpScopeInTx(tx, [scope]);
        return { restored, skipped };
    });
}
