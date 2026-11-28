import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import { gateRecordingSessionRequest } from "@/lib/recording-sessions/route-gate";
import { serializeRecordingSession } from "@/lib/recording-sessions/serialize";
import {
    listRecordingSessionChunks,
    replaceRecordingSession,
} from "@/lib/recording-sessions/store";

type IdContext = { params: Promise<{ id: string }> };

/** Create one replacement upload session for the same encrypted capture. */
export const POST = apiHandler<IdContext>(async (request, context) => {
    const gate = await gateRecordingSessionRequest(request);
    if (gate.response) return gate.response;
    const { id } = await (context as IdContext).params;
    const { session, sealed } = await replaceRecordingSession({
        userId: gate.authn.user.id,
        apiKeyId: gate.authn.apiKeyId,
        sessionId: id,
    });
    const chunks = sealed
        ? await listRecordingSessionChunks(session.id, gate.authn.user.id)
        : [];
    return NextResponse.json(
        {
            ...serializeRecordingSession(session, chunks),
            ...(sealed && {
                encryption: { protocol: sealed.protocol, kid: sealed.kid },
            }),
        },
        {
            status: 201,
        },
    );
});
