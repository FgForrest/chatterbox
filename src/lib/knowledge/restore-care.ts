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

const BATCH = 1000;

function chunks<T>(rows: T[]): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < rows.length; i += BATCH)
        out.push(rows.slice(i, i + BATCH));
    return out;
}

/** Restore after Organization records, usage and facts, recomputing local fingerprints and checking every target. */
export async function restoreCareArchive(
    actorId: string,
    archive: CareArchive,
    idMap: Record<string, string> = {},
): Promise<{ restored: number; skipped: number }> {
    const scope = await requireCareCurator(actorId);
    const mapId = (id: string) =>
        Object.hasOwn(idMap, id) ? (idMap[id] ?? id) : id;
    return db.transaction(async (tx) => {
        await lockOrgPeople(tx);
        await requireCareCurator(actorId);
        let skipped = 0;
        const pairs = archive.duplicates.map((pair) => ({
            kind: pair.kind,
            ids: [mapId(pair.left), mapId(pair.right)].sort(),
        }));
        const live = new Set<string>();
        for (const kind of ["person", "entity"] as const) {
            const table = kind === "person" ? people : knowledgeEntities;
            const ids = [
                ...new Set(
                    pairs
                        .filter((pair) => pair.kind === kind)
                        .flatMap((pair) => pair.ids),
                ),
            ];
            for (const batch of chunks(ids))
                for (const row of await tx
                    .select({ id: table.id })
                    .from(table)
                    .where(
                        and(
                            eq(table.userId, scope),
                            inArray(table.id, batch),
                            isNull(table.mergedIntoId),
                        ),
                    ))
                    live.add(`${kind}:${row.id}`);
        }
        const dismissals: (typeof almanacDuplicateDismissals.$inferInsert)[] =
            [];
        for (const { kind, ids } of pairs) {
            const [left, right] = ids;
            if (
                !left ||
                !right ||
                left === right ||
                !live.has(`${kind}:${left}`) ||
                !live.has(`${kind}:${right}`)
            ) {
                skipped++;
                continue;
            }
            dismissals.push({
                userId: scope,
                kind,
                ...(kind === "person"
                    ? { leftPersonId: left, rightPersonId: right }
                    : { leftEntityId: left, rightEntityId: right }),
                dismissedByUserId: actorId,
            });
        }
        const current = new Map(
            (await detectCareProblems(scope, tx)).map((problem) => [
                JSON.stringify(careProblemContent(problem)),
                problem,
            ]),
        );
        for (const saved of archive.problems) {
            const mapped = {
                ...saved,
                records: saved.records
                    .map((record) => ({ ...record, id: mapId(record.id) }))
                    .sort((a, b) => a.id.localeCompare(b.id)),
                relationKey: saved.relationKey
                    ? mapId(saved.relationKey)
                    : null,
            };
            const match = current.get(JSON.stringify(mapped));
            if (!match) {
                skipped++;
                continue;
            }
            dismissals.push({
                userId: scope,
                kind: match.kind,
                problemKey: match.key,
                problemData: encryptJsonField(careProblemContent(match)),
                dismissedByUserId: actorId,
            });
        }
        for (const batch of chunks(dismissals))
            await tx
                .insert(almanacDuplicateDismissals)
                .values(batch)
                .onConflictDoNothing();
        await bumpScopeInTx(tx, [scope]);
        return { restored: dismissals.length, skipped };
    });
}
