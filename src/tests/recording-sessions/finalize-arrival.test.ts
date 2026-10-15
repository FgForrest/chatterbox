import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, ErrorCode } from "@/lib/errors";
import { assertCategorizableFolder } from "@/lib/folders/folders";
import type { StorageProvider } from "@/lib/storage/types";

vi.mock("nanoid", () => ({ nanoid: () => "session-recording" }));
vi.mock("@/db", () => ({ db: { transaction: vi.fn() } }));
vi.mock("@/db/items", () => ({ insertAudioItem: vi.fn() }));
vi.mock("@/lib/audio/server-waveform", () => ({
    generateFileWaveform: vi.fn().mockResolvedValue([0, 0.5, 1]),
}));
vi.mock("@/lib/audio/ingest-waveform", () => ({
    generateIngestWaveform: vi.fn().mockResolvedValue([0, 0.5, 1]),
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
vi.mock("@/lib/folders/folders", () => ({
    assertCategorizableFolder: vi.fn(async () => ({
        folderId: "folder-1",
        ownerId: "user-session",
        scope: "personal",
    })),
}));
const { requestArrivalInTx } = vi.hoisted(() => ({
    requestArrivalInTx: vi.fn(async () => ({ shouldNudge: true })),
}));
vi.mock("@/lib/pipeline/arrival", () => ({
    requestArrivalInTx,
    resolveArrivalProfile: vi.fn(async () => ({
        id: "profile-1",
        ownerUserId: "user-session",
        channel: "audio",
    })),
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
    readAudioDurationMs: vi.fn().mockResolvedValue(30_000),
}));

import { db } from "@/db";
import { insertAudioItem } from "@/db/items";
import { saveUploadedAudio } from "@/lib/uploads/save-uploaded-audio";
import { saveUploadedAudioFile } from "@/lib/uploads/save-uploaded-audio-file";

describe("recording-session finalization arrival", () => {
    const uploadStream = vi.fn().mockResolvedValue("stored");
    const uploadFile = vi.fn().mockResolvedValue("stored");
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    const storage = {
        uploadStream,
        uploadFile,
        deleteFile,
    } as unknown as StorageProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        uploadStream.mockResolvedValue("stored");
        uploadFile.mockResolvedValue("stored");
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
            folderId: "folder-1",
        });

        expect(insertAudioItem).toHaveBeenCalledWith(
            db,
            expect.objectContaining({
                id: "session-recording",
                userId: "user-session",
                plaudFileId: "meeting-client-recording",
                occurredAt: recordedAt,
            }),
            expect.objectContaining({
                pipeline: "arrival",
                initializeInTx: expect.any(Function),
            }),
        );
        const options = vi.mocked(insertAudioItem).mock.calls[0]?.[2];
        if (options?.pipeline !== "arrival" || !options.initializeInTx) {
            throw new Error("arrival initializer was not passed");
        }
        const tx = {} as Parameters<typeof options.initializeInTx>[0];
        await options.initializeInTx(tx, {
            itemId: "session-recording",
            userId: "user-session",
        });
        expect(requestArrivalInTx).toHaveBeenCalledWith(tx, {
            itemId: "session-recording",
            userId: "user-session",
            folder: {
                folderId: "folder-1",
                ownerId: "user-session",
                scope: "personal",
            },
            profile: expect.objectContaining({ id: "profile-1" }),
        });
    });

    it("files later when a deferred session folder becomes unusable", async () => {
        vi.mocked(assertCategorizableFolder).mockRejectedValueOnce(
            new AppError(ErrorCode.NOT_FOUND, "Folder not found", 404),
        );
        const warning = vi
            .spyOn(console, "warn")
            .mockImplementation(() => undefined);

        await saveUploadedAudioFile({
            userId: "user-session",
            fileId: "meeting-client-recording",
            basename: "Design review",
            extension: ".ogg",
            filePath: join(__dirname, "..", "fixtures", "sample.mp3"),
            storage,
            recordedAt: new Date("2026-10-15T08:00:00.000Z"),
            folderId: "folder-1",
            deferredFolderFallback: {
                kind: "recording session",
                id: "session-1",
            },
        });

        const options = vi.mocked(insertAudioItem).mock.calls[0]?.[2];
        if (options?.pipeline !== "arrival" || !options.initializeInTx) {
            throw new Error("arrival initializer was not passed");
        }
        await options.initializeInTx(
            {} as Parameters<typeof options.initializeInTx>[0],
            { itemId: "session-recording", userId: "user-session" },
        );
        expect(requestArrivalInTx).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ folder: null, profile: null }),
        );
        expect(warning).toHaveBeenCalledWith(
            "[recording session session-1] selected folder is unavailable; saved without placement",
        );
        warning.mockRestore();
    });

    it("files later when a video extraction folder becomes unusable", async () => {
        vi.mocked(assertCategorizableFolder).mockRejectedValueOnce(
            new AppError(
                ErrorCode.INVALID_INPUT,
                "Folder is no longer writable",
                400,
            ),
        );
        const warning = vi
            .spyOn(console, "warn")
            .mockImplementation(() => undefined);

        await saveUploadedAudio({
            userId: "user-session",
            fileId: "uploaded-video",
            basename: "Design review",
            extension: ".m4a",
            buffer: Buffer.from("audio"),
            storage,
            sourceExtension: ".mkv",
            convertedFromVideo: true,
            folderId: "folder-1",
            deferredFolderFallback: {
                kind: "video extraction job",
                id: "job-1",
            },
        });

        const options = vi.mocked(insertAudioItem).mock.calls[0]?.[2];
        if (options?.pipeline !== "arrival" || !options.initializeInTx) {
            throw new Error("arrival initializer was not passed");
        }
        await options.initializeInTx(
            {} as Parameters<typeof options.initializeInTx>[0],
            { itemId: "session-recording", userId: "user-session" },
        );
        expect(requestArrivalInTx).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ folder: null, profile: null }),
        );
        expect(warning).toHaveBeenCalledWith(
            "[video extraction job job-1] selected folder is unavailable; saved without placement",
        );
        warning.mockRestore();
    });
});
