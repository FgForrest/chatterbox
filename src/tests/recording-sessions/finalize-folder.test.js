import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/jobs/retryable", () => ({ isRetryableError: () => false }));
vi.mock("@/lib/recording-sessions/finalize-job", () => ({
    parseRecordingSessionFinalizePayload: (value) => value,
    RECORDING_SESSION_FINALIZE_JOB_KIND: "recording-session-finalize",
    RECORDING_SESSION_FINALIZE_MAX_ATTEMPTS: 1,
    RECORDING_SESSION_FINALIZE_TIMEOUT_MS: 10000,
}));
vi.mock("node:child_process", () => ({
    spawn: (_command, args) => {
        const child = new EventEmitter();
        child.stderr = Readable.from([]);
        queueMicrotask(() => {
            writeFileSync(args.at(-1), "remuxed audio");
            child.emit("close", 0);
        });
        return child;
    },
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn(async () => ({
        downloadStream: async () =>
            Readable.from([Buffer.from("captured audio")]),
    })),
}));
vi.mock("@/lib/uploads/save-uploaded-audio-file", () => ({
    saveUploadedAudioFile: mocks.save,
}));
vi.mock("@/lib/recording-sessions/store", () => ({
    getRecordingSessionForUser: mocks.getSession,
    getRecordingForCapture: vi.fn(async () => null),
    listRecordingSessionChunks: vi.fn(async () => [
        { index: 0, storageKey: "chunk-0" },
    ]),
    markRecordingSessionCompleted: vi.fn(async () => true),
    markRecordingSessionFailed: vi.fn(),
    purgeRecordingSessionChunks: vi.fn(),
}));

import { recordingSessionFinalizeJobHandler } from "@/lib/recording-sessions/finalize-job-handler";

beforeEach(() => {
    vi.clearAllMocks();
    mocks.save.mockResolvedValue({
        recordingId: "recording",
        durationMs: 1000,
        filesize: 12,
    });
});

describe("finalize job folder target", () => {
    it.each([
        "changed",
        null,
    ])("files into the session's completed target %j", async (folderId) => {
        mocks.getSession.mockResolvedValue({
            id: "session",
            userId: "owner",
            status: "completing",
            folderId,
            clientRecordingId: "capture",
            startedAt: new Date("2026-10-20T10:00:00Z"),
            metadata: { channelLayout: ["mixed"] },
            expectedChunkCount: 1,
        });
        const result = await recordingSessionFinalizeJobHandler.run({
            payload: { sessionId: "session" },
            userId: "owner",
            attempt: 1,
            maxAttempts: 1,
            signal: new AbortController().signal,
        });
        expect(result.recordingId).toBe("recording");
        expect(mocks.getSession).toHaveBeenCalledWith("session", "owner");
        expect(mocks.save).toHaveBeenCalledWith(
            expect.objectContaining({
                folderId,
                userId: "owner",
                sessionId: "session",
            }),
        );
    });
});
