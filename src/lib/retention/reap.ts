import {
    claimRemoteOriginalReap,
    clearReapedMarkers,
    deleteSummaryForRecording,
    deleteTranscriptsForRecording,
    type ReapCandidate,
    type RetentionGovernor,
    type RetentionKind,
    type RetentionPolicy,
    reapAudioForRecording,
    releaseRemoteOriginalReapClaim,
} from "@/db/queries/retention";
import { movePlaudRecordingToTrash } from "@/lib/recordings/erase";
import type { StorageProvider } from "@/lib/storage/types";

export type { RetentionKind } from "@/db/queries/retention";

export interface ReapOutcome {
    /** Kinds whose data was removed on this pass. */
    reaped: RetentionKind[];
    /** Kind -> why it was skipped, for the worker's log line. */
    skipped: Partial<Record<RetentionKind, string>>;
    /** Kind -> operational error. Other independent kinds still run. */
    failed: Partial<Record<RetentionKind, unknown>>;
}

function isDue(startTime: Date, retentionDays: number | null, now: Date) {
    if (retentionDays === null) return false;
    return (
        startTime.getTime() <
        now.getTime() - retentionDays * 24 * 60 * 60 * 1000
    );
}

/**
 * Remove the kinds of data this policy selects from one aged recording.
 *
 * The recording row itself is never deleted. Retention takes payload --
 * the audio blob, the transcript rows, the summary row -- and leaves the
 * metadata (title, date, duration) in place, marked with what went and
 * when. That keeps the library legible after a sweep: a recording shows
 * up as "audio removed by retention" rather than vanishing or, worse,
 * turning into a broken player.
 *
 * Markdown sidecars are deliberately NOT touched. `<recording>.transcript.md`
 * is an *export* the user asked to have written into a folder they own,
 * not Riffado's copy of the data, and deleting files out of someone's
 * Documents folder is not a thing a retention setting should quietly do.
 * Removing the export is a manual act.
 *
 * A shared recording is the Organization's policy's, and only its: each
 * kind is re-checked before it goes, the rows under the lock sharing and
 * withdrawing take, so a share or withdrawal since the sweep chose it
 * wins. `orgUserId` is the organization account an owner's policy yields
 * shared recordings to, or null when this instance shows no Organization.
 */
export async function reapRecording(
    storage: StorageProvider,
    policy: RetentionPolicy,
    recording: ReapCandidate,
    now = new Date(),
    orgUserId: string | null = null,
): Promise<ReapOutcome> {
    const governor: RetentionGovernor = policy.isOrg
        ? { isOrg: true, orgUserId: policy.userId }
        : { isOrg: false, orgUserId };
    const reaped: RetentionKind[] = [];
    const skipped: Partial<Record<RetentionKind, string>> = {};
    const failed: Partial<Record<RetentionKind, unknown>> = {};
    let audioPresent: boolean | undefined;

    const hasLocalAudio = async () => {
        if (audioPresent === undefined) {
            audioPresent = await storage.exists(recording.storagePath);
        }
        return audioPresent;
    };

    if (
        isDue(recording.startTime, policy.remoteOriginalDays, now) &&
        recording.deviceSn !== "local" &&
        !recording.isTrash
    ) {
        if (recording.downloadedAt === null) {
            skipped.remoteOriginal = "audio has not been downloaded locally";
        } else if (
            !(await claimRemoteOriginalReap(recording.id, policy.userId, now))
        ) {
            skipped.remoteOriginal = "claimed by another worker";
        } else {
            try {
                await movePlaudRecordingToTrash(policy.userId, recording.id);
                reaped.push("remoteOriginal");
            } catch (error) {
                failed.remoteOriginal = error;
            } finally {
                try {
                    await releaseRemoteOriginalReapClaim(
                        recording.id,
                        policy.userId,
                        now,
                    );
                } catch (error) {
                    failed.remoteOriginal ??= error;
                }
            }
        }
    }

    if (
        isDue(recording.startTime, policy.audioDays, now) &&
        recording.audioReapedAt === null
    ) {
        const audioReaped = await reapAudioForRecording(
            recording.id,
            recording.userId,
            governor,
            now,
            async () => {
                // `deleteFile` throws on a key that isn't there, and
                // "already gone" is a perfectly ordinary state here (a
                // failed stamp on an earlier tick, a manual cleanup). Check
                // first so a missing blob settles the marker instead of
                // retrying forever, and a genuine storage failure still
                // surfaces as a failure.
                if (await hasLocalAudio()) {
                    await storage.deleteFile(recording.storagePath);
                }
            },
        );
        if (audioReaped) {
            reaped.push("audio");
        } else {
            skipped.audio = "no longer governed by this policy";
        }
    }

    if (
        isDue(recording.startTime, policy.transcriptDays, now) &&
        recording.transcriptReapedAt === null
    ) {
        const removed = await deleteTranscriptsForRecording(
            recording.id,
            recording.userId,
            governor,
            now,
        );
        if (removed > 0) {
            reaped.push("transcript");
        } else {
            skipped.transcript = "no transcript to remove";
        }
    }

    if (
        isDue(recording.startTime, policy.summaryDays, now) &&
        recording.summaryReapedAt === null
    ) {
        const removed = await deleteSummaryForRecording(
            recording.id,
            recording.userId,
            governor,
            now,
        );
        if (removed > 0) {
            reaped.push("summary");
        } else {
            skipped.summary = "no summary to remove";
        }
    }

    // Each kind's marker was stamped with its deletion, whichever policy
    // reaped it: the markers describe the recording.
    return { reaped, skipped, failed };
}

/**
 * Drop the markers for kinds whose data is present again. Call this from
 * the paths that legitimately restore data -- a re-run transcription, a
 * regenerated summary, a re-downloaded blob -- so the sweep's bookkeeping
 * never outlives the condition it describes.
 */
export async function unmarkReaped(
    userId: string,
    recordingId: string,
    kinds: readonly RetentionKind[],
): Promise<void> {
    await clearReapedMarkers(recordingId, userId, kinds);
}
