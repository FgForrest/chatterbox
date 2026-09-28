import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { db } from "@/db";
import { aiEnhancements, recordings, transcriptions } from "@/db/schema";

/**
 * Reading the Organization view of shared recordings.
 *
 * Sharing takes the Organization's own snapshot of the transcripts and
 * summaries. A recording shared before snapshots existed, until the backfill
 * or its first change takes one, shows the owner's instead, read-only: the
 * owner chose to share it, and an empty panel would only send everyone to
 * re-run work that already exists. Once the snapshot is taken the owner's
 * rows are never shown here: what the Organization's retention removed stays
 * removed, and what the owner makes afterwards stays theirs.
 */

type TranscriptionRow = typeof transcriptions.$inferSelect;

const FALLBACK_SOURCE_ORDER = ["riffado", "mixed", "plaud"] as const;

export interface ViewOwners {
    contentUserId: string;
    ownerUserId: string;
}

export interface SharedRecordingRef {
    id: string;
    ownerUserId: string;
    /** `recordings.orgSnapshotAt`: once set, the owner's rows are not shown. */
    orgSnapshotAt: Date | null;
}

/** The owner's rows of the recordings that may still fall back to them. */
function ownerRowsCondition(
    table: typeof transcriptions | typeof aiEnhancements,
    refs: SharedRecordingRef[],
) {
    return or(
        ...refs
            .filter((ref) => ref.orgSnapshotAt === null)
            .map((ref) =>
                and(
                    eq(table.recordingId, ref.id),
                    eq(table.userId, ref.ownerUserId),
                ),
            ),
    );
}

/**
 * Whether the Organization view of a recording may still show the owner's
 * rows: only until the Organization took its snapshot.
 */
export async function ownerRowsShownInOrgView(
    recordingId: string,
): Promise<boolean> {
    const [row] = await db
        .select({ orgSnapshotAt: recordings.orgSnapshotAt })
        .from(recordings)
        .where(eq(recordings.id, recordingId))
        .limit(1);
    return row !== undefined && row.orgSnapshotAt === null;
}

/**
 * Transcripts of the Organization view for many recordings: the
 * organization's rows where they exist, otherwise the owner's.
 */
export async function readOrgViewTranscriptRows(
    refs: SharedRecordingRef[],
    orgUserId: string,
): Promise<{ rows: TranscriptionRow[]; fallbackRecordingIds: Set<string> }> {
    if (refs.length === 0) {
        return { rows: [], fallbackRecordingIds: new Set() };
    }
    const own = await db
        .select()
        .from(transcriptions)
        .where(
            and(
                inArray(
                    transcriptions.recordingId,
                    refs.map((ref) => ref.id),
                ),
                eq(transcriptions.userId, orgUserId),
            ),
        );
    const covered = new Set(own.map((row) => row.recordingId));
    const missing = refs.filter(
        (ref) => !covered.has(ref.id) && ref.orgSnapshotAt === null,
    );
    const fallback =
        missing.length > 0
            ? await db
                  .select()
                  .from(transcriptions)
                  .where(ownerRowsCondition(transcriptions, missing))
            : [];
    return {
        rows: [...own, ...fallback],
        fallbackRecordingIds: new Set(fallback.map((row) => row.recordingId)),
    };
}

/** Recording ids with a summary in the Organization view, fallback included. */
export async function readOrgViewSummaryRecordingIds(
    refs: SharedRecordingRef[],
    orgUserId: string,
): Promise<Set<string>> {
    if (refs.length === 0) return new Set();
    const rows = await db
        .select({ recordingId: aiEnhancements.recordingId })
        .from(aiEnhancements)
        .where(
            and(
                isNotNull(aiEnhancements.summary),
                or(
                    and(
                        inArray(
                            aiEnhancements.recordingId,
                            refs.map((ref) => ref.id),
                        ),
                        eq(aiEnhancements.userId, orgUserId),
                    ),
                    ownerRowsCondition(aiEnhancements, refs),
                ),
            ),
        );
    return new Set(rows.map((row) => row.recordingId));
}

/**
 * The transcript an Organization summary is generated from.
 *
 * The organization's own transcript when there is one, else, before its
 * snapshot, the owner's; either way preferring a provider's output over an
 * edit, and both over an import.
 */
export async function findOrgSummarySource(
    recordingId: string,
    owners: ViewOwners,
): Promise<TranscriptionRow | undefined> {
    const ownRows = await db
        .select()
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, owners.contentUserId),
            ),
        );
    for (const source of FALLBACK_SOURCE_ORDER) {
        const row = ownRows.find((item) => item.source === source);
        if (row) return row;
    }
    if (!(await ownerRowsShownInOrgView(recordingId))) return undefined;
    const ownerRows = await db
        .select()
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, owners.ownerUserId),
            ),
        );
    for (const source of FALLBACK_SOURCE_ORDER) {
        const row = ownerRows.find((item) => item.source === source);
        if (row) return row;
    }
    return undefined;
}

/**
 * Whose rows a view's reads come from right now.
 *
 * The Organization view reads the organization's rows once it has any of
 * the requested kind or took its snapshot, and the owner's until then.
 */
export async function effectiveViewReader(
    recordingId: string,
    owners: ViewOwners,
    kind: "transcript" | "summary",
): Promise<{ userId: string; fallback: boolean }> {
    if (owners.contentUserId === owners.ownerUserId) {
        return { userId: owners.contentUserId, fallback: false };
    }
    const own =
        kind === "transcript"
            ? await db
                  .select({ id: transcriptions.id })
                  .from(transcriptions)
                  .where(
                      and(
                          eq(transcriptions.recordingId, recordingId),
                          eq(transcriptions.userId, owners.contentUserId),
                      ),
                  )
                  .limit(1)
            : await db
                  .select({ id: aiEnhancements.id })
                  .from(aiEnhancements)
                  .where(
                      and(
                          eq(aiEnhancements.recordingId, recordingId),
                          eq(aiEnhancements.userId, owners.contentUserId),
                      ),
                  )
                  .limit(1);
    return own.length > 0 || !(await ownerRowsShownInOrgView(recordingId))
        ? { userId: owners.contentUserId, fallback: false }
        : { userId: owners.ownerUserId, fallback: true };
}

/**
 * Summaries of the Organization view for many recordings: per recording the
 * organization's rows where it has any, otherwise the owner's.
 */
export async function readOrgViewSummaryRows(
    refs: SharedRecordingRef[],
    orgUserId: string,
): Promise<
    { id: string; recordingId: string; source: string; userId: string }[]
> {
    if (refs.length === 0) return [];
    const rows = await db
        .select({
            id: aiEnhancements.id,
            recordingId: aiEnhancements.recordingId,
            source: aiEnhancements.source,
            userId: aiEnhancements.userId,
        })
        .from(aiEnhancements)
        .where(
            or(
                and(
                    inArray(
                        aiEnhancements.recordingId,
                        refs.map((ref) => ref.id),
                    ),
                    eq(aiEnhancements.userId, orgUserId),
                ),
                ownerRowsCondition(aiEnhancements, refs),
            ),
        );
    const withOwn = new Set(
        rows
            .filter((row) => row.userId === orgUserId)
            .map((row) => row.recordingId),
    );
    return rows.filter(
        (row) => row.userId === orgUserId || !withOwn.has(row.recordingId),
    );
}
