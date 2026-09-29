import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { recordings, transcriptions } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { listCorrections } from "@/lib/knowledge/corrections";
import { knowledgeView } from "@/lib/knowledge/knowledge-loader";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { isRecordingShared } from "@/lib/sharing/shared";
import { assertMayChange } from "@/lib/sharing/writer";

type IdContext = { params: Promise<{ id: string }> };

/**
 * The corrections on one transcript of the recording (`?source=plaud`, or
 * the Riffado one), as everyone reading it in the view sees them: while it
 * is shared the Organization's, otherwise the owner's. Each carries what
 * it means (its target's current name), and `canUndo` says whether the
 * viewer may take them back (whoever may change the recording in the view).
 */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const view = requestedRecordingView(request);
    const access = await requireRecordingView(session.user.id, id, view);
    const source =
        new URL(request.url).searchParams.get("source") === "plaud"
            ? "plaud"
            : "riffado";
    const [transcript] = await db
        .select({ id: transcriptions.id, revision: transcriptions.revision })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, id),
                eq(transcriptions.userId, access.contentUserId),
                eq(transcriptions.source, source),
            ),
        )
        .limit(1);
    if (!transcript) {
        throw new AppError(ErrorCode.NOT_FOUND, "No such transcript", 404);
    }
    // Read under the recording held for share, in the sharing state the
    // request was authorized in: a withdrawal (or a share) landing since
    // would otherwise hand a member the owner's private corrections.
    const corrections = await db.transaction(async (tx) => {
        await tx
            .select({ id: recordings.id })
            .from(recordings)
            .where(eq(recordings.id, id))
            .for("share");
        const sharedNow =
            access.orgUserId !== null &&
            (await isRecordingShared(id, access.orgUserId, tx));
        if (sharedNow !== access.shared) {
            throw new AppError(
                ErrorCode.RECORDING_NOT_FOUND,
                "Recording not found",
                404,
            );
        }
        return listCorrections(access.contentUserId, transcript.id, tx);
    });
    const names = new Map(
        (
            await knowledgeView({
                kind: "recording",
                ownerUserId: access.contentUserId,
                shared: access.shared,
            })
        ).items.map((item) => [item.id, item.name]),
    );
    let canUndo = true;
    try {
        assertMayChange(access, session.user.id);
    } catch {
        canUndo = false;
    }
    return NextResponse.json({
        transcriptionId: transcript.id,
        revision: transcript.revision,
        canUndo,
        corrections: corrections.map((correction) => ({
            id: correction.id,
            turnIndex: correction.turnIndex,
            charStart: correction.charStart,
            charEnd: correction.charEnd,
            heard: correction.heard,
            kind: correction.kind,
            replacement: correction.replacement,
            meaning:
                names.get(
                    correction.targetPersonId ??
                        correction.targetEntityId ??
                        "",
                ) ??
                correction.replacement ??
                correction.heard,
        })),
    });
});
