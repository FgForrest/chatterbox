import { NextResponse } from "next/server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { enqueueRecordingSessionFinalize } from "@/lib/recording-sessions/finalize-job";
import { parseCompleteRecordingSessionBody } from "@/lib/recording-sessions/metadata";
import { gateRecordingSessionRequest } from "@/lib/recording-sessions/route-gate";
import { serializeRecordingSession } from "@/lib/recording-sessions/serialize";
import {
    getRecordingSessionForUser,
    listRecordingSessionChunks,
    markRecordingSessionCompleting,
    setRecordingSessionJob,
} from "@/lib/recording-sessions/store";

type IdContext = { params: Promise<{ id: string }> };

/**
 * `POST /api/v1/recording-sessions/{id}/complete` — finish a session.
 *
 * Verifies that chunks 0..chunkCount-1 all arrived, moves the session to
 * `completing`, and enqueues the finalize job that assembles and remuxes
 * the audio into a recording. The response carries the job id so the client
 * can follow `/api/jobs/{jobId}` to know when the recording is ready.
 */
export const POST = apiHandler<IdContext>(async (request, context) => {
    const gate = await gateRecordingSessionRequest(request);
    if (gate.response) return gate.response;
    const { authn } = gate;
    const { id } = await (context as IdContext).params;

    const body = await request.json().catch(() => null);
    const input = parseCompleteRecordingSessionBody(body);

    const session = await getRecordingSessionForUser(id, authn.user.id);
    if (!session) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Recording session not found",
            404,
        );
    }

    // Idempotent re-complete: if a previous call already advanced the
    // session, hand back its current state rather than erroring.
    if (session.status !== "open") {
        const chunks = await listRecordingSessionChunks(session.id);
        return NextResponse.json(serializeRecordingSession(session, chunks));
    }

    const chunks = await listRecordingSessionChunks(session.id);
    if (chunks.length !== input.chunkCount) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `Expected ${input.chunkCount} chunks but ${chunks.length} were uploaded`,
            422,
            { field: "chunkCount" },
        );
    }
    for (let i = 0; i < chunks.length; i++) {
        if (chunks[i].index !== i) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                `Recording is missing chunk ${i}; re-send the gaps before completing`,
                422,
                { missingChunk: i },
            );
        }
    }

    const completing = await markRecordingSessionCompleting({
        sessionId: session.id,
        userId: authn.user.id,
        endedAt: input.endedAt,
        stopReason: input.stopReason,
        expectedChunkCount: input.chunkCount,
    });
    if (!completing) {
        // Lost the race with another complete call; report the live state.
        const current = await getRecordingSessionForUser(id, authn.user.id);
        if (!current) {
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Recording session not found",
                404,
            );
        }
        return NextResponse.json(serializeRecordingSession(current, chunks));
    }

    const enqueued = await enqueueRecordingSessionFinalize({
        userId: authn.user.id,
        sessionId: session.id,
    });
    await setRecordingSessionJob(session.id, enqueued.job.id);

    return NextResponse.json(
        serializeRecordingSession(
            { ...completing, jobId: enqueued.job.id },
            chunks,
        ),
        { status: 202 },
    );
});
