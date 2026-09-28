import { AppError, ErrorCode } from "@/lib/errors";
import { getOrgUserId } from "@/lib/org/config";
import { isRecordingShared } from "@/lib/sharing/shared";

/**
 * A shared recording's private copy is frozen: the owner's transcripts and
 * speakers stay as they were shared until the owner withdraws it.
 *
 * The freeze follows the Organization this instance shows. Switched to
 * `local` mode there is none, and the owner's copy is theirs again. That
 * never reaches the Organization: its snapshot is rows of its own, which
 * nothing the owner does afterwards changes. For the same reason the
 * owner's retention and erasure still delete their own copy.
 */

/**
 * The organization account a private copy can be frozen for, or null when
 * this instance shows no Organization.
 *
 * Resolve it before the write's transaction, then check sharing through
 * that transaction (`isRecordingShared(recordingId, orgUserId, tx)`):
 * looked up inside, it would take a second pooled connection while the
 * first holds the recording lock, and enough concurrent writers would
 * exhaust the pool.
 */
export function freezingOrgUserId(): Promise<string | null> {
    return getOrgUserId();
}

/**
 * Whether a recording's private copy is frozen right now. Outside a
 * transaction only: for refusing early, before work that a write would
 * refuse anyway.
 */
export async function isPrivateCopyFrozen(
    recordingId: string,
): Promise<boolean> {
    const orgUserId = await freezingOrgUserId();
    return (
        orgUserId !== null && (await isRecordingShared(recordingId, orgUserId))
    );
}

/** The refusal of a change to a frozen private copy. */
export function recordingShared(): AppError {
    return new AppError(
        ErrorCode.RECORDING_SHARED,
        "This recording is shared with the Organization; withdraw it to change its transcript or speakers",
        409,
    );
}
