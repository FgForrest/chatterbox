import { AppError, ErrorCode } from "@/lib/errors";
import { assertOrgScopeWritable, getOrgUserId } from "@/lib/org/config";
import type { RecordingViewContext } from "@/lib/sharing/access";
import {
    contentWriterRefusal,
    type WriterRefusal,
} from "@/lib/sharing/writer-rule";

export {
    contentWriterRefusal,
    type WriterRefusal,
    writerRefusal,
} from "@/lib/sharing/writer-rule";

/**
 * The organization account sharing is decided against, or null when this
 * instance shows no Organization.
 *
 * Resolve it before a write's transaction, then pass it to
 * `contentWriterRefusal` with that transaction: looked up inside, it would
 * take a second pooled connection while the first holds the recording
 * lock, and enough concurrent writers would exhaust the pool.
 */
export function sharingOrgUserId(): Promise<string | null> {
    return getOrgUserId();
}

/**
 * `contentWriterRefusal` outside a transaction: for refusing early, before
 * work a write would refuse anyway.
 */
export async function contentWriterRefusalNow(input: {
    recordingId: string;
    ownerUserId: string;
    actorUserId: string;
}): Promise<WriterRefusal | null> {
    return contentWriterRefusal(undefined, {
        ...input,
        orgUserId: await sharingOrgUserId(),
    });
}

/** The refusal of an owner's change to a shared recording. */
export function recordingShared(): AppError {
    return new AppError(
        ErrorCode.RECORDING_SHARED,
        "This recording is shared with the Organization; only the organization account changes it. Withdraw it to change it yourself",
        409,
    );
}

/** The refusal of a change to a recording the actor can no longer see. */
export function recordingGone(): AppError {
    return new AppError(
        ErrorCode.RECORDING_NOT_FOUND,
        "Recording not found",
        404,
    );
}

/** The error for a refusal. */
export function writerRefusalError(refusal: WriterRefusal): AppError {
    return refusal === "shared" ? recordingShared() : recordingGone();
}

/**
 * Refuse a request to change a recording in a view, before any work: on
 * the Organization view anyone but the organization account (403), and
 * the owner of a shared recording on the private view (409). The write
 * checks again under the recording lock (`contentWriterRefusal`).
 */
export function assertMayChange(
    access: Pick<RecordingViewContext, "view" | "shared" | "orgUserId">,
    actorUserId: string,
): void {
    if (access.view === "org") {
        assertOrgScopeWritable();
        if (actorUserId !== access.orgUserId) {
            throw new AppError(
                ErrorCode.FORBIDDEN,
                "Only the organization account changes a shared recording",
                403,
            );
        }
    } else if (access.shared) {
        throw recordingShared();
    }
}
