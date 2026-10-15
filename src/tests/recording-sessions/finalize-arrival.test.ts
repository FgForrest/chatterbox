import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageProvider } from "@/lib/storage/types";

vi.mock("nanoid", () => ({ nanoid: () => "session-recording" }));
vi.mock("@/db", () => ({ db: { transaction: vi.fn() } }));
vi.mock("@/db/items", () => ({ insertAudioItem: vi.fn() }));
vi.mock("@/lib/audio/server-waveform", () => ({
    generateFileWaveform: vi.fn().mockResolvedValue([0, 0.5, 1]),
}));
vi.mock("@/lib/encryption/fields", () => ({
    encryptText: vi.fn((value: string) => `encrypted:${value}`),
}));
vi.mock("@/lib/env", () => ({
    env: { DEFAULT_STORAGE_TYPE: "local" },
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/recordings/filename", () => ({
    buildRecordingStagingPath: vi.fn(
        () => "user-session/.pending/session-recording.ogg",
    ),
}));
vi.mock("@/lib/recordings/storage-reconciliation-job", () => ({
    enqueueStorageReconciliationJob: vi.fn().mockResolvedValue({
        created: true,
    }),
}));
vi.mock("@/lib/uploads/audio-duration", () => ({
    readAudioFileDurationMs: vi.fn().mockResolvedValue(30_000),
}));

import { db } from "@/db";
import { insertAudioItem } from "@/db/items";
import { saveUploadedAudioFile } from "@/lib/uploads/save-uploaded-audio-file";

describe("recording-session finalization arrival", () => {
    const uploadStream = vi.fn().mockResolvedValue("stored");
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    const storage = {
        uploadStream,
        deleteFile,
    } as unknown as StorageProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        uploadStream.mockResolvedValue("stored");
        deleteFile.mockResolvedValue(undefined);
        vi.mocked(insertAudioItem).mockResolvedValue({
            id: "session-recording",
        });
    });

    it("marks the finalized recording as a pipeline arrival", async () => {
        const recordedAt = new Date("2026-10-15T08:00:00.000Z");

        await saveUploadedAudioFile({
            userId: "user-session",
            fileId: "meeting-client-recording",
            basename: "Design review",
            extension: ".ogg",
            filePath: join(__dirname, "..", "fixtures", "sample.mp3"),
            storage,
            recordedAt,
        });

        expect(insertAudioItem).toHaveBeenCalledWith(
            db,
            expect.objectContaining({
                id: "session-recording",
                userId: "user-session",
                plaudFileId: "meeting-client-recording",
                occurredAt: recordedAt,
            }),
            { pipeline: "arrival" },
        );
    });
});
