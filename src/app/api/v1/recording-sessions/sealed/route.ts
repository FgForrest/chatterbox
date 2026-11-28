import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import { recorderRoomKey } from "@/lib/meetings/room-key";
import { readProcessing } from "@/lib/pipeline/state";
import {
    MAX_CHUNK_BYTES,
    MAX_SESSION_BYTES,
} from "@/lib/recording-sessions/constants";
import { parseCreateRecordingSessionBody } from "@/lib/recording-sessions/metadata";
import { parseSealedCapture } from "@/lib/recording-sessions/offline-key";
import { gateRecordingSessionRequest } from "@/lib/recording-sessions/route-gate";
import { serializeRecordingSession } from "@/lib/recording-sessions/serialize";
import {
    createSealedRecordingSession,
    listRecordingSessionChunks,
} from "@/lib/recording-sessions/store";

/**
 * `POST /api/v1/recording-sessions/sealed`: open, or replay, the protocol 2
 * session of a capture encrypted to the user's offline key. An exact retry
 * answers 200 with the current session, a new one 201.
 */
export const POST = apiHandler(async (request: Request) => {
    const gate = await gateRecordingSessionRequest(request);
    if (gate.response) return gate.response;
    const { authn } = gate;
    const body: unknown = await request.json().catch(() => null);
    const raw =
        body && typeof body === "object"
            ? (body as Record<string, unknown>)
            : {};
    const sealed = parseSealedCapture(raw.encryption);
    const input = parseCreateRecordingSessionBody(
        raw.liveAgendaId !== undefined
            ? { ...raw, agendaId: raw.liveAgendaId }
            : raw,
    );
    const roomKey = recorderRoomKey(input.meetCode);
    if (roomKey) input.metadata.roomKey = roomKey;

    const { session, replayed } = await createSealedRecordingSession(
        {
            userId: authn.user.id,
            apiKeyId: authn.apiKeyId,
            clientRecordingId: input.clientRecordingId,
            mimeType: input.mimeType,
            metadata: input.metadata,
            startedAt: input.startedAt,
            noticeAcknowledgedAt: input.noticeAcknowledgedAt,
            folderId: input.folderId,
        },
        sealed,
    );

    const [chunks, processing] = await Promise.all([
        replayed ? listRecordingSessionChunks(session.id, authn.user.id) : [],
        session.recordingId
            ? readProcessing(session.recordingId, "private", authn.user.id)
            : null,
    ]);
    return NextResponse.json(
        {
            ...serializeRecordingSession(session, chunks, processing?.phases),
            encryption: { protocol: sealed.protocol, kid: sealed.kid },
            limits: {
                max_chunk_bytes: MAX_CHUNK_BYTES,
                max_session_bytes: MAX_SESSION_BYTES,
            },
        },
        { status: replayed ? 200 : 201 },
    );
});
