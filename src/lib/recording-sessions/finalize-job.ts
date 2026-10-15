import { type EnqueueJobResult, enqueueJob } from "@/db/queries/async-jobs";
import { nudge } from "@/lib/jobs/nudge";
import { InvalidJobPayloadError } from "@/lib/jobs/types";

export const RECORDING_SESSION_FINALIZE_JOB_KIND = "recording-session-finalize";
export const RECORDING_SESSION_FINALIZE_MAX_ATTEMPTS = 3;
export const RECORDING_SESSION_FINALIZE_TIMEOUT_MS = 30 * 60 * 1000;

export interface RecordingSessionFinalizePayload {
    sessionId: string;
}

export function parseRecordingSessionFinalizePayload(
    raw: Record<string, unknown>,
): RecordingSessionFinalizePayload {
    if (typeof raw.sessionId !== "string" || raw.sessionId.length === 0) {
        throw new InvalidJobPayloadError(
            RECORDING_SESSION_FINALIZE_JOB_KIND,
            "sessionId must be a non-empty string",
        );
    }
    return { sessionId: raw.sessionId };
}

export async function enqueueRecordingSessionFinalize(input: {
    userId: string;
    sessionId: string;
}): Promise<EnqueueJobResult> {
    const enqueued = await enqueueJob({
        userId: input.userId,
        kind: RECORDING_SESSION_FINALIZE_JOB_KIND,
        subjectId: input.sessionId,
        // Interactive: the person who just stopped recording is waiting.
        priority: 5,
        maxAttempts: RECORDING_SESSION_FINALIZE_MAX_ATTEMPTS,
        payload: { sessionId: input.sessionId },
    });
    if (enqueued.created) nudge();
    return enqueued;
}
