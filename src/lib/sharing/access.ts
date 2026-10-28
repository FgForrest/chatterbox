import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { isItemReceived } from "@/db/queries/item-shares";
import { type ContentItemKind, chatterItems, recordings } from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { getOrgUserId } from "@/lib/org/config";
import { isRecordingShared } from "@/lib/sharing/shared";
import type { RecordingView } from "@/lib/sharing/view";

export {
    isRecordingShared,
    sharedRecordingCondition,
} from "@/lib/sharing/shared";

export type { RecordingView } from "@/lib/sharing/view";
export { recordingJobSubject } from "@/lib/sharing/view";

/**
 * - `owner`: the recording's owner.
 * - `member`: any other regular user, on a shared recording.
 * - `curator`: the organization account, on a shared recording.
 */
export type RecordingAccessRole = "owner" | "member" | "curator" | "receiver";

export interface RecordingAccess {
    recordingId: string;
    /** What the item is: a recording unless the caller admitted other kinds. */
    kind: ContentItemKind;
    ownerUserId: string;
    role: RecordingAccessRole;
    shared: boolean;
    received?: boolean;
    orgUserId: string | null;
}

export interface ReadableRecordingViewContext extends RecordingAccess {
    view: RecordingView;
    /**
     * Owner of the transcript and summary rows this view reads and writes:
     * the recording's owner in both views. A shared recording is one
     * recording; the views differ in who may change it, not in its rows.
     */
    contentUserId: string;
}

/** A view that can be passed to processing and Learn after writer authorization. */
export type RecordingViewContext = ReadableRecordingViewContext & {
    view: "private" | "org";
};

export interface AccessOptions {
    /**
     * The item kinds the caller handles. A recording only by default, so a
     * route made for audio answers 404 for a mail id before doing anything.
     */
    kinds?: readonly ContentItemKind[];
}

async function findItem(
    itemId: string,
    kinds: readonly ContentItemKind[] | undefined,
): Promise<{ userId: string; kind: ContentItemKind } | null> {
    if (!kinds || (kinds.length === 1 && kinds[0] === "audio")) {
        const [recording] = await db
            .select({ id: recordings.id, userId: recordings.userId })
            .from(recordings)
            .where(and(eq(recordings.id, itemId), isNull(recordings.deletedAt)))
            .limit(1);
        return recording ? { userId: recording.userId, kind: "audio" } : null;
    }
    const [item] = await db
        .select({ userId: chatterItems.userId, kind: chatterItems.kind })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, itemId),
                inArray(chatterItems.kind, [...kinds]),
                isNull(chatterItems.deletedAt),
            ),
        )
        .limit(1);
    return item && item.kind !== "meeting"
        ? { ...item, kind: item.kind }
        : null;
}

/**
 * Who `userId` is to `recordingId`, or null when they may not see it at all.
 *
 * Callers turn null into a 404 so the answer never reveals that a recording
 * exists.
 */
export async function resolveRecordingAccess(
    userId: string,
    recordingId: string,
    options: AccessOptions = {},
): Promise<RecordingAccess | null> {
    const recording = await findItem(recordingId, options.kinds);
    if (!recording) return null;

    const orgUserId = await getOrgUserId();
    const shared = orgUserId
        ? await isRecordingShared(recordingId, orgUserId)
        : false;

    if (recording.userId === userId) {
        return {
            recordingId,
            kind: recording.kind,
            ownerUserId: recording.userId,
            role: "owner",
            shared,
            orgUserId,
        };
    }
    const received = await isItemReceived(userId, recordingId);
    if (!shared && !received) return null;
    return {
        recordingId,
        kind: recording.kind,
        ownerUserId: recording.userId,
        role: shared
            ? userId === orgUserId
                ? "curator"
                : "member"
            : "receiver",
        shared,
        received,
        orgUserId,
    };
}

/** Read `?view=org` from a request URL; anything else is the private view. */
export function requestedRecordingView(request: Request): RecordingView {
    const view = new URL(request.url).searchParams.get("view");
    return view === "org" || view === "received" ? view : "private";
}

/**
 * Authorize a request against one view of a recording.
 *
 * The private view is the owner's alone. The Organization view exists only
 * while the recording is shared, for the owner and every other account.
 */
export async function requireRecordingView<V extends RecordingView>(
    userId: string,
    recordingId: string,
    view: V,
    options: AccessOptions = {},
): Promise<ReadableRecordingViewContext & { view: V }> {
    const access = await resolveRecordingAccess(userId, recordingId, options);
    const allowed =
        access !== null &&
        (view === "private"
            ? access.role === "owner"
            : view === "received"
              ? access.received === true
              : access.shared && access.orgUserId !== null);
    if (!access || !allowed) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }
    return { ...access, view, contentUserId: access.ownerUserId };
}

/**
 * Authorize a view-independent read of a recording (its audio, its
 * waveform): the owner, or anyone while it is shared.
 */
export async function requireRecordingAccess(
    userId: string,
    recordingId: string,
    options: AccessOptions = {},
): Promise<RecordingAccess> {
    const access = await resolveRecordingAccess(userId, recordingId, options);
    if (!access) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }
    return access;
}
