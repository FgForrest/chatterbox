import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { recordingItemJoin } from "@/db/items";
import { chatterItems, recordings, userSettings } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { applyGeneratedTitle } from "@/lib/recordings/apply-generated-title";
import { readTitleInput } from "@/lib/recordings/title-input";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { notifyIfShared } from "@/lib/sharing/notify";
import {
    assertMayChange,
    contentWriterRefusalNow,
    writerRefusalError,
} from "@/lib/sharing/writer";
import { emitEvent } from "@/lib/webhooks/emit";

type IdContext = { params: Promise<{ id: string }> };

export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const access = await requireRecordingView(
        session.user.id,
        id,
        requestedRecordingView(request),
    );
    assertMayChange(access, session.user.id);
    const ownerUserId = access.ownerUserId;
    const [recording] = await db
        .select({
            plaudFileId: recordings.plaudFileId,
            titleEditedAt: chatterItems.titleEditedAt,
        })
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .where(
            and(
                eq(recordings.id, id),
                eq(recordings.userId, ownerUserId),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);
    if (!recording) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }
    const refusal = await contentWriterRefusalNow({
        recordingId: id,
        ownerUserId,
        actorUserId: session.user.id,
    });
    if (refusal) throw writerRefusalError(refusal);

    const input = await readTitleInput(ownerUserId, id);
    if (!input) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Generate a transcript or summary before regenerating the title",
            400,
        );
    }
    const [settings] = await db
        .select({ syncTitleToPlaud: userSettings.syncTitleToPlaud })
        .from(userSettings)
        .where(eq(userSettings.userId, ownerUserId))
        .limit(1);
    const retitled = await applyGeneratedTitle({
        userId: ownerUserId,
        actorUserId: session.user.id,
        recordingId: id,
        ...input,
        plaudFileId: recording.plaudFileId,
        syncTitleToPlaud:
            access.view === "private" && (settings?.syncTitleToPlaud ?? false),
        expectedTitleEditedAt: recording.titleEditedAt,
    });
    if (!retitled) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Could not regenerate the title. Check your title provider or retry if the recording changed.",
            409,
        );
    }
    const [updated] = await db
        .select({ title: chatterItems.title })
        .from(chatterItems)
        .where(
            and(eq(chatterItems.id, id), eq(chatterItems.userId, ownerUserId)),
        )
        .limit(1);
    await emitEvent("recording.updated", ownerUserId, id);
    await notifyIfShared(id);
    return NextResponse.json({ filename: decryptText(updated?.title) });
});
