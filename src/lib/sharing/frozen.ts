import { db } from "@/db";
import { AppError, ErrorCode } from "@/lib/errors";
import { getOrgUserId } from "@/lib/org/config";
import { isRecordingShared } from "@/lib/sharing/shared";

type Executor = Pick<typeof db, "select">;

/**
 * Whether a recording's private copy is frozen: it is shared with the
 * Organization, so its transcripts and speakers stay as they were shared
 * until the owner withdraws it. Pass the transaction holding the recording
 * lock, so the answer holds for the write it guards.
 */
export async function isPrivateCopyFrozen(
    recordingId: string,
    executor: Executor = db,
): Promise<boolean> {
    const orgUserId = await getOrgUserId();
    return (
        orgUserId !== null &&
        (await isRecordingShared(recordingId, orgUserId, executor))
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
