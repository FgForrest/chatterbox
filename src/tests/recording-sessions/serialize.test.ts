import { describe, expect, it } from "vitest";
import { serializeProcessing } from "@/lib/pipeline/serialize";
import { serializeRecordingSession } from "@/lib/recording-sessions/serialize";
import type { RecordingSessionRow } from "@/lib/recording-sessions/store";

const now = new Date("2026-10-15T10:00:00.000Z");
const session: RecordingSessionRow = {
    id: "session",
    userId: "owner",
    captureKeyId: "capture-key",
    clientRecordingId: "client-recording",
    apiKeyId: "api-key",
    status: "completed",
    mimeType: "audio/webm",
    folderId: "folder",
    metadata: {},
    noticeAcknowledgedAt: now,
    startedAt: now,
    endedAt: now,
    stopReason: "user",
    expectedChunkCount: 1,
    truncatedAtChunk: null,
    recordingId: "recording",
    jobId: "job",
    lastError: null,
    terminalCode: null,
    createdAt: now,
    updatedAt: now,
};

describe("recording session serialization", () => {
    it("includes its folder and current recording processing", () => {
        const serialized = serializeRecordingSession(session, [], {
            categorize: {
                state: "done",
                generation: 1,
                at: now.toISOString(),
            },
            transcribe: {
                state: "running",
                generation: 1,
                at: now.toISOString(),
            },
        });

        expect(serialized.folder_id).toBe("folder");
        expect(serialized.processing).toEqual({
            phase: "transcribe",
            state: "running",
        });
    });

    it("reports pending categorization before a session has a recording", () => {
        expect(
            serializeRecordingSession(
                { ...session, recordingId: null, status: "open" },
                [],
            ).processing,
        ).toEqual({ phase: "categorize", state: "pending" });
    });

    it("reports the last settled legacy phase when legacy content exists", () => {
        expect(
            serializeProcessing({
                categorize: {
                    state: "skipped",
                    reason: "legacy",
                    generation: 0,
                    at: now.toISOString(),
                },
                learn: {
                    state: "done",
                    reason: "legacy",
                    generation: 0,
                    at: now.toISOString(),
                },
                summary: {
                    state: "done",
                    reason: "legacy",
                    generation: 0,
                    at: now.toISOString(),
                },
            }),
        ).toEqual({ phase: "summary", state: "done" });
    });

    it("reports skipped categorization for legacy items without content", () => {
        expect(
            serializeProcessing({
                categorize: {
                    state: "skipped",
                    reason: "legacy",
                    generation: 0,
                    at: now.toISOString(),
                },
            }),
        ).toEqual({ phase: "categorize", state: "skipped" });
    });
});
