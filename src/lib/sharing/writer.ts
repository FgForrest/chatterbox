import { AppError, ErrorCode } from "@/lib/errors";
import { assertOrgScopeWritable, getOrgUserId } from "@/lib/org/config";
import type { RecordingViewContext } from "@/lib/sharing/access";
import {
    contentWriterRefusal,
    type WriterRefusal,
} from "@/lib/sharing/writer-rule";

export {
    contentWriterRefusal,
    contentWriterScope,
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
    actsForOrganization?: boolean;
}): Promise<WriterRefusal | null> {
    return contentWriterRefusal(undefined, {
        ...input,
        orgUserId: await sharingOrgUserId(),
    });
}

/** The refusal of an unauthorized change to a shared recording. */
export function recordingShared(): AppError {
    return new AppError(
        ErrorCode.RECORDING_SHARED,
        "Only the owner, the organization account or a curator may change this shared recording",
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

/** Authorize a content change before checking again under the recording lock. */
export function assertMayChange(
    access: Pick<
        RecordingViewContext,
        "view" | "shared" | "orgUserId" | "ownerUserId"
    >,
    actorUserId: string,
    actsForOrganization = actorUserId === access.orgUserId,
): void {
    if (access.view === "org" || access.shared) {
        assertOrgScopeWritable();
        if (actorUserId !== access.ownerUserId && !actsForOrganization) {
            throw new AppError(
                ErrorCode.FORBIDDEN,
                "Only the owner, the organization account or a curator may change this shared recording",
                403,
            );
        }
    }
}
