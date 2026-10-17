import { serializeProcessing } from "@/lib/pipeline/serialize";
import type { PipelinePhases } from "@/lib/pipeline/types";
import type { RecordingSessionChunkRow, RecordingSessionRow } from "./store";

/**
 * Public view of a session on `/api/v1/recording-sessions`.
 *
 * Snake case like the rest of the v1 surface. `received_chunks` is the
 * sorted list of indices the server has committed, which is what a client
 * resuming after a restart needs to know which chunks to re-send.
 */
export function serializeRecordingSession(
    session: RecordingSessionRow,
    chunks: Pick<RecordingSessionChunkRow, "index" | "size">[],
    phases?: PipelinePhases | null,
) {
    const indices = chunks.map((chunk) => chunk.index).sort((a, b) => a - b);
    const receivedBytes = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
    return {
        id: session.id,
        status: session.status,
        mime_type: session.mimeType,
        metadata: session.metadata,
        started_at: session.startedAt,
        ended_at: session.endedAt,
        stop_reason: session.stopReason,
        notice_acknowledged_at: session.noticeAcknowledgedAt,
        expected_chunk_count: session.expectedChunkCount,
        truncated_at_chunk: session.truncatedAtChunk,
        received_chunks: indices,
        received_bytes: receivedBytes,
        folder_id: session.folderId,
        recording_id: session.recordingId,
        job_id: session.jobId,
        error: session.lastError,
        terminal_code: session.terminalCode,
        processing: session.recordingId
            ? serializeProcessing(phases)
            : { phase: "categorize" as const, state: "pending" as const },
        created_at: session.createdAt,
        updated_at: session.updatedAt,
        links: {
            self: `/api/v1/recording-sessions/${session.id}`,
            job: session.jobId ? `/api/jobs/${session.jobId}` : null,
            recording: session.recordingId
                ? `/api/v1/recordings/${session.recordingId}`
                : null,
        },
    };
}
