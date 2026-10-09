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
        received_chunks: indices,
        received_bytes: receivedBytes,
        recording_id: session.recordingId,
        job_id: session.jobId,
        error: session.lastError,
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
