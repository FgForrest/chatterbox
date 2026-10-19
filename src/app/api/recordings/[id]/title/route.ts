import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { chatterItems, recordings, userSettings } from "@/db/schema";
import { requireApiSessionActor } from "@/lib/auth-server";
import { actsForOrganization } from "@/lib/authz/curator";
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
    const { session, actor } = await requireApiSessionActor(request);
    const { id } = await (context as IdContext).params;
    const access = await requireRecordingView(
        session.user.id,
        id,
        requestedRecordingView(request),
        { kinds: ["audio", "mail"] },
    );
    const curates = access.view === "org" && (await actsForOrganization(actor));
    assertMayChange(access, session.user.id, curates);
    const ownerUserId = access.ownerUserId;
    const [item] = await db
        .select({
            titleEditedAt: chatterItems.titleEditedAt,
        })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, id),
                eq(chatterItems.userId, ownerUserId),
                eq(chatterItems.kind, access.kind),
                isNull(chatterItems.deletedAt),
            ),
        )
        .limit(1);
    if (!item) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }
    const [recording] =
        access.kind === "audio"
            ? await db
                  .select({ plaudFileId: recordings.plaudFileId })
                  .from(recordings)
                  .where(
                      and(
                          eq(recordings.id, id),
                          eq(recordings.userId, ownerUserId),
                          isNull(recordings.deletedAt),
                      ),
                  )
                  .limit(1)
            : [{ plaudFileId: undefined }];
    const refusal = await contentWriterRefusalNow({
        recordingId: id,
        ownerUserId,
        actorUserId: session.user.id,
        actsForOrganization: curates,
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
    const [settings] =
        access.kind === "audio"
            ? await db
                  .select({ syncTitleToPlaud: userSettings.syncTitleToPlaud })
                  .from(userSettings)
                  .where(eq(userSettings.userId, ownerUserId))
                  .limit(1)
            : [{ syncTitleToPlaud: false }];
    const retitled = await applyGeneratedTitle({
        userId: ownerUserId,
        actorUserId: session.user.id,
        recordingId: id,
        ...input,
        kind: access.kind,
        view: access.view,
        plaudFileId: recording?.plaudFileId,
        syncTitleToPlaud:
            access.kind === "audio" &&
            access.view === "private" &&
            (settings?.syncTitleToPlaud ?? false),
        expectedTitleEditedAt: item.titleEditedAt,
        actsForOrganization: curates,
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
