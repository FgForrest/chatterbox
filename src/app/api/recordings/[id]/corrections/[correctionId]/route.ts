import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { transcriptCorrections, transcriptions } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { revertCorrection } from "@/lib/knowledge/corrections";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { assertMayChange, sharingOrgUserId } from "@/lib/sharing/writer";

type CorrectionContext = {
    params: Promise<{ id: string; correctionId: string }>;
};

/**
 * Undo a correction: the transcript reads as it was heard there again.
 * Whoever may change the recording in the view; 404 alike for a missing
 * correction, one on another recording and one of another scope.
 */
export const DELETE = apiHandler<CorrectionContext>(
    async (request, context) => {
        const session = await requireApiSession(request);
        const { id, correctionId } = await (context as CorrectionContext)
            .params;
        const view = requestedRecordingView(request);
        const access = await requireRecordingView(session.user.id, id, view);
        assertMayChange(access, session.user.id);
        const [row] = await db
            .select({ transcriptionId: transcriptCorrections.transcriptionId })
            .from(transcriptCorrections)
            .innerJoin(
                transcriptions,
                eq(transcriptions.id, transcriptCorrections.transcriptionId),
            )
            .where(
                and(
                    eq(transcriptCorrections.id, correctionId),
                    eq(transcriptions.recordingId, id),
                    eq(transcriptions.userId, access.contentUserId),
                ),
            )
            .limit(1);
        if (!row) {
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Correction not found",
                404,
            );
        }
        await revertCorrection({
            userId: access.contentUserId,
            transcriptionId: row.transcriptionId,
            actorUserId: session.user.id,
            orgUserId: await sharingOrgUserId(),
            correctionId,
        });
        return NextResponse.json({ ok: true });
    },
);
