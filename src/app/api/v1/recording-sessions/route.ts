import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import {
    MAX_CHUNK_BYTES,
    MAX_SESSION_BYTES,
} from "@/lib/recording-sessions/constants";
import { parseCreateRecordingSessionBody } from "@/lib/recording-sessions/metadata";
import { gateRecordingSessionRequest } from "@/lib/recording-sessions/route-gate";
import { serializeRecordingSession } from "@/lib/recording-sessions/serialize";
import {
    createRecordingSession,
    listRecordingSessionsForUser,
} from "@/lib/recording-sessions/store";

/**
 * `POST /api/v1/recording-sessions` — open a streaming recording session.
 *
 * The extension calls this once at the start of a meeting, then PUTs chunks
 * to `.../chunks/{index}` as they are captured, and finally POSTs to
 * `.../complete`. Requires the `recordings:write` scope.
 */
export const POST = apiHandler(async (request: Request) => {
    const gate = await gateRecordingSessionRequest(request);
    if (gate.response) return gate.response;
    const { authn } = gate;

    const body = await request.json().catch(() => null);
    const input = parseCreateRecordingSessionBody(body);

    const session = await createRecordingSession({
        userId: authn.user.id,
        mimeType: input.mimeType,
        metadata: input.metadata,
        startedAt: input.startedAt,
        noticeAcknowledgedAt: input.noticeAcknowledgedAt,
    });

    return NextResponse.json(
        {
            ...serializeRecordingSession(session, []),
            limits: {
                max_chunk_bytes: MAX_CHUNK_BYTES,
                max_session_bytes: MAX_SESSION_BYTES,
            },
        },
        { status: 201 },
    );
});

/** `GET /api/v1/recording-sessions` — list the caller's sessions, newest first. */
export const GET = apiHandler(async (request: Request) => {
    const gate = await gateRecordingSessionRequest(request);
    if (gate.response) return gate.response;
    const { authn } = gate;

    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw
        ? Math.min(100, Math.max(1, Number.parseInt(limitRaw, 10) || 25))
        : 25;

    const sessions = await listRecordingSessionsForUser(authn.user.id, {
        limit,
    });

    return NextResponse.json({
        data: sessions.map((session) => serializeRecordingSession(session, [])),
    });
});
