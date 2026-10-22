import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { recordings } from "@/db/schema";
import { requireApiSessionActor } from "@/lib/auth-server";
import { actsForOrganization } from "@/lib/authz/curator";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { refreshExistingRecordingSidecars } from "@/lib/export/document-sidecars";
import { recordingLanguage } from "@/lib/recordings/language";
import { recordingLanguageMetadata } from "@/lib/recordings/language-metadata";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { notifyIfShared } from "@/lib/sharing/notify";
import {
    assertMayChange,
    contentWriterRefusal,
    sharingOrgUserId,
    writerRefusalError,
} from "@/lib/sharing/writer";

import { emitEvent } from "@/lib/webhooks/emit";

type Context = { params: Promise<{ id: string }> };

export const GET = apiHandler<Context>(async (request, context) => {
    const { session, actor } = await requireApiSessionActor(request);
    const { id } = await (context as Context).params;
    const access = await requireRecordingView(
        session.user.id,
        id,
        requestedRecordingView(request),
    );
    let canChange = true;
    try {
        assertMayChange(
            access,
            session.user.id,
            await actsForOrganization(actor),
        );
    } catch (error) {
        if (!(error instanceof AppError)) throw error;
        canChange = false;
    }
    return NextResponse.json({
        ...(await recordingLanguageMetadata(
            access.ownerUserId,
            id,
            access.view,
            session.user.id,
        )),
        canChange,
    });
});

const input = z.object({
    language: z
        .string()
        .refine((value) => recordingLanguage(value) !== null)
        .nullable(),
});

export const PATCH = apiHandler<Context>(async (request, context) => {
    const { session, actor } = await requireApiSessionActor(request);
    const { id } = await (context as Context).params;
    const access = await requireRecordingView(
        session.user.id,
        id,
        requestedRecordingView(request),
    );
    const curates = await actsForOrganization(actor);
    assertMayChange(access, session.user.id, curates);
    const parsed = input.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Choose a supported recording language",
            400,
        );
    const orgUserId = await sharingOrgUserId();
    const changed = await db.transaction(async (tx) => {
        const [row] = await tx
            .select({
                id: recordings.id,
                confirmedLanguage: recordings.confirmedLanguage,
            })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, id),
                    eq(recordings.userId, access.ownerUserId),
                    isNull(recordings.deletedAt),
                ),
            )
            .for("update");
        if (!row)
            throw new AppError(
                ErrorCode.RECORDING_NOT_FOUND,
                "Recording not found",
                404,
            );
        const refusal = await contentWriterRefusal(tx, {
            recordingId: id,
            ownerUserId: access.ownerUserId,
            actorUserId: session.user.id,
            orgUserId,
            actsForOrganization: curates,
        });
        if (refusal) throw writerRefusalError(refusal);
        if (row.confirmedLanguage === parsed.data.language) return false;
        await tx
            .update(recordings)
            .set({
                confirmedLanguage: parsed.data.language,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(recordings.id, id),
                    eq(recordings.userId, access.ownerUserId),
                ),
            );
        return true;
    });
    if (changed) {
        await refreshExistingRecordingSidecars(access.ownerUserId, id);
        await emitEvent("recording.updated", access.ownerUserId, id);
        await notifyIfShared(id);
    }
    return NextResponse.json(
        await recordingLanguageMetadata(
            access.ownerUserId,
            id,
            access.view,
            session.user.id,
        ),
    );
});
