import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    addRecordingToFolder,
    moveRecordingBetweenFolders,
    removeRecordingFromFolder,
    unshareRecording,
} from "@/lib/folders/folders";
import { isSummaryStale } from "@/lib/learn/summary-refresh";

type IdContext = { params: Promise<{ id: string }> };

function readString(body: unknown, field: string): string {
    const value =
        typeof body === "object" && body !== null && field in body
            ? (body as Record<string, unknown>)[field]
            : null;
    if (typeof value !== "string" || !value) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            `${field} is required`,
            400,
            { field },
        );
    }
    return value;
}

/** File a recording in a folder. An Organization folder shares it (owner only). */
export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const folderId = readString(
        await request.json().catch(() => null),
        "folderId",
    );
    await addRecordingToFolder({
        userId: session.user.id,
        recordingId: id,
        folderId,
    });
    // Shared: the Organization reads its own corrections, so a summary
    // made with the owner's may be stale there (it says so on its view).
    return NextResponse.json({
        assigned: true,
        // Shared already: a failure here says nothing about the share.
        summaryStale: await isSummaryStale(session.user.id, id).catch(
            () => false,
        ),
    });
});

/** Move a recording from one folder to another in the same tree. */
export const PATCH = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const body = await request.json().catch(() => null);
    await moveRecordingBetweenFolders({
        userId: session.user.id,
        recordingId: id,
        fromFolderId: readString(body, "fromFolderId"),
        toFolderId: readString(body, "toFolderId"),
    });
    return NextResponse.json({ moved: true });
});

/**
 * Take a recording out of a folder, or with `{ "organization": true }` out of
 * the whole Organization tree. Out of Organization folders: its owner or the
 * organization account; taking it out of its last Organization folder, or
 * out of the whole tree, needs `{ "withdraw": true }` (409
 * WITHDRAW_UNCONFIRMED otherwise), sent once the owner's retention warning
 * was seen (`withdraw-preview`).
 */
export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const body = await request.json().catch(() => null);
    if (
        typeof body === "object" &&
        body !== null &&
        (body as { organization?: unknown }).organization === true
    ) {
        await unshareRecording(session.user.id, id, {
            withdraw: (body as { withdraw?: unknown }).withdraw === true,
        });
        return NextResponse.json({ shared: false });
    }
    await removeRecordingFromFolder({
        userId: session.user.id,
        recordingId: id,
        folderId: readString(body, "folderId"),
        withdraw: (body as { withdraw?: unknown }).withdraw === true,
    });
    return NextResponse.json({ assigned: false });
});
