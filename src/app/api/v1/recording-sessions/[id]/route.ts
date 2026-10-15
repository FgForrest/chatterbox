import { NextResponse } from "next/server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { readProcessing } from "@/lib/pipeline/state";
import { gateRecordingSessionRequest } from "@/lib/recording-sessions/route-gate";
import { serializeRecordingSession } from "@/lib/recording-sessions/serialize";
import {
    getRecordingSessionForUser,
    listRecordingSessionChunks,
    markRecordingSessionAborted,
    purgeRecordingSessionChunks,
    retireRecordingCaptureKey,
} from "@/lib/recording-sessions/store";
import { createUserStorageProvider } from "@/lib/storage/factory";

type IdContext = { params: Promise<{ id: string }> };

/**
 * `GET /api/v1/recording-sessions/{id}` — session status and received chunks.
 *
 * The resume path: a client whose service worker restarted reads
 * `received_chunks` to learn which indices it still needs to send.
 */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const gate = await gateRecordingSessionRequest(request);
    if (gate.response) return gate.response;
    const { authn } = gate;
    const { id } = await (context as IdContext).params;

    const session = await getRecordingSessionForUser(id, authn.user.id);
    if (!session) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Recording session not found",
            404,
        );
    }
    if (session.apiKeyId !== authn.apiKeyId) {
        throw new AppError(ErrorCode.FORBIDDEN, "Recorder key mismatch", 403);
    }
    const chunks = await listRecordingSessionChunks(session.id);
    const processing = session.recordingId
        ? await readProcessing(session.recordingId, "private", authn.user.id)
        : null;

    return NextResponse.json(
        serializeRecordingSession(session, chunks, processing?.phases),
    );
});

/**
 * `DELETE /api/v1/recording-sessions/{id}` — abort and delete chunks.
 *
 * Only an `open` or `failed` session can be aborted; one that is finalizing
 * or already finalized is left alone, since a recording may already exist.
 */
export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const gate = await gateRecordingSessionRequest(request);
    if (gate.response) return gate.response;
    const { authn } = gate;
    const { id } = await (context as IdContext).params;

    const session = await getRecordingSessionForUser(id, authn.user.id);
    if (!session) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Recording session not found",
            404,
        );
    }
    if (session.apiKeyId !== authn.apiKeyId) {
        throw new AppError(ErrorCode.FORBIDDEN, "Recorder key mismatch", 403);
    }

    const aborted = await markRecordingSessionAborted(
        session.id,
        authn.user.id,
        "user_discard",
        "Aborted by client",
    );
    if (!aborted) {
        throw new AppError(
            ErrorCode.CONFLICT,
            `Cannot abort a session that is ${session.status}`,
            409,
        );
    }

    const storage = await createUserStorageProvider(authn.user.id);
    await purgeRecordingSessionChunks(storage, session.id);
    await retireRecordingCaptureKey({
        userId: authn.user.id,
        captureKeyId: session.captureKeyId,
    });

    return NextResponse.json({ success: true });
});
