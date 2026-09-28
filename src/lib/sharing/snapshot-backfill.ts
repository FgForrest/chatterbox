import { and, asc, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recordings } from "@/db/schema";
import { lockOrgPeople } from "@/lib/knowledge/people";
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";
import { snapshotRecordingForOrgInTx } from "@/lib/sharing/org-transcript";
import { sharedRecordingCondition } from "@/lib/sharing/shared";

const PAGE_SIZE = 50;

/**
 * Take the Organization's snapshot of every recording shared before
 * snapshots existed: those still shared with no `orgSnapshotAt`.
 *
 * They are grandfathered past the share gate. Each gets whatever
 * transcript source or summary the Organization has no row of, and
 * existing Organization rows win. A recording already marked is never
 * filled again, so what Organization retention removed stays removed.
 * The copies are recorded as produced by the owner, who shared it.
 *
 * Pages by id, 50 at a time; each recording is its own transaction, which
 * re-checks under its locks that it is still shared, not deleted and not
 * yet snapshotted. An error is logged and the recording left for the next
 * start. Safe to run in several processes at once.
 */
export async function backfillOrgSnapshots(): Promise<number> {
    if (!isOrgScopeEnabled()) return 0;
    const orgUserId = await getOrgUserId();
    if (!orgUserId) return 0;

    let visited = 0;
    let after = "";
    for (;;) {
        const page = await db
            .select({ id: recordings.id, ownerUserId: recordings.userId })
            .from(recordings)
            .where(
                and(
                    isNull(recordings.orgSnapshotAt),
                    isNull(recordings.deletedAt),
                    sharedRecordingCondition(orgUserId),
                    gt(recordings.id, after),
                ),
            )
            .orderBy(asc(recordings.id))
            .limit(PAGE_SIZE);
        for (const recording of page) {
            try {
                await db.transaction(async (tx) => {
                    // Before the recording lock the snapshot takes: it
                    // promotes people, which may merge them.
                    await lockOrgPeople(tx);
                    await snapshotRecordingForOrgInTx(
                        tx,
                        recording.id,
                        {
                            ownerUserId: recording.ownerUserId,
                            contentUserId: orgUserId,
                        },
                        recording.ownerUserId,
                    );
                });
                visited += 1;
            } catch (error) {
                console.error(
                    `[org-snapshot] could not snapshot recording ${recording.id}:`,
                    error,
                );
            }
        }
        const last = page.at(-1);
        if (!last || page.length < PAGE_SIZE) return visited;
        after = last.id;
    }
}

let backfillStarted = false;

/** Run the backfill once, in the background, at startup. */
export function startOrgSnapshotBackfill(): void {
    if (backfillStarted) return;
    backfillStarted = true;
    void backfillOrgSnapshots()
        .then((visited) => {
            if (visited > 0) {
                console.log(
                    `[org-snapshot] snapshotted ${visited} shared recording(s)`,
                );
            }
        })
        .catch((error) => {
            console.error("[org-snapshot] backfill failed:", error);
        });
}
