import { NextResponse } from "next/server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { gateRecordingSessionRequest } from "@/lib/recording-sessions/route-gate";
import { serializeRecordingSession } from "@/lib/recording-sessions/serialize";
import {
    getRecordingSessionForUser,
    listRecordingSessionChunks,
    markRecordingSessionAborted,
    purgeRecordingSessionChunks,
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
    const chunks = await listRecordingSessionChunks(session.id);

    return NextResponse.json(serializeRecordingSession(session, chunks));
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

    const aborted = await markRecordingSessionAborted(
        session.id,
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

    return NextResponse.json({ success: true });
});
