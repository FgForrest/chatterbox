import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, deleteItemTaskDataInTx, lockItemTaskGraphInTx } = vi.hoisted(
    () => ({
        dbMock: {
            select: vi.fn(),
            transaction: vi.fn(),
        },
        deleteItemTaskDataInTx: vi.fn(),
        lockItemTaskGraphInTx: vi.fn(),
    }),
);

vi.mock("@/db", () => ({ db: dbMock }));
// Erasing a shared recording withdraws it, which reaches the folders and
// the Organization's configuration; neither is exercised here.
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/plaud/client-factory", () => ({
    createPlaudClient: vi.fn(),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
}));
vi.mock("@/db/items", () => ({
    recordingItemJoin: undefined,
    touchRecording: vi.fn(),
}));
vi.mock("@/lib/folders/folders", () => ({
    lockOrgTree: vi.fn(),
    orgTreeChanged: vi.fn(),
    withdrawRecordingInTx: vi.fn(),
}));
vi.mock("@/lib/knowledge/fact-evidence", () => ({
    knowledgeOnRecordingInTx: vi.fn(),
    pruneUnsupportedFactsInTx: vi.fn(),
}));
vi.mock("@/lib/knowledge/scope-generation", () => ({
    bumpScopeInTx: vi.fn(),
}));
vi.mock("@/lib/sharing/shared", () => ({
    isRecordingShared: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/sharing/writer", () => ({
    contentWriterRefusal: vi.fn(),
    contentWriterRefusalNow: vi.fn(),
    recordingShared: vi.fn(),
    sharingOrgUserId: vi.fn().mockResolvedValue(null),
    writerRefusalError: vi.fn(),
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        deleteFile: vi.fn().mockResolvedValue(undefined),
    }),
}));
vi.mock("@/lib/tasks/mentions", () => ({
    deleteItemTaskDataInTx,
    deleteItemTaskVectorsInTx: vi.fn(),
    lockItemTaskGraphInTx,
}));
vi.mock("@/lib/tasks/store", () => ({
    dropTasksWithoutSummaryInTx: vi.fn(),
}));

import {
    deleteRecordingStorageArtifacts,
    eraseLocalArtifact,
    storageKeysForErase,
} from "@/lib/recordings/erase";
import type { StorageProvider } from "@/lib/storage/types";

function storageWithDelete(deleteFile: StorageProvider["deleteFile"]) {
    return { deleteFile } as StorageProvider;
}

describe("recording artifact erasure", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("covers legacy and provider-scoped transcript exports", () => {
        expect(
            storageKeysForErase("users/u/Meeting.ogg", "transcript"),
        ).toEqual([
            "users/u/Meeting.transcript.md",
            "users/u/Meeting.plaud.transcript.md",
            "users/u/Meeting.custom.transcript.md",
            "users/u/Meeting.mixed.transcript.md",
        ]);
    });

    it("deletes audio plus every transcript and summary sidecar", async () => {
        const deleteFile = vi.fn().mockResolvedValue(undefined);

        await deleteRecordingStorageArtifacts(
            storageWithDelete(deleteFile),
            "users/u/Meeting.ogg",
            "all",
        );

        expect(deleteFile).toHaveBeenCalledTimes(9);
        expect(deleteFile).toHaveBeenCalledWith("users/u/Meeting.ogg");
        expect(deleteFile).toHaveBeenCalledWith(
            "users/u/Meeting.plaud.summary.md",
        );
        expect(deleteFile).toHaveBeenCalledWith(
            "users/u/Meeting.custom.transcript.md",
        );
    });

    it("treats already-absent exports as an idempotent success", async () => {
        const missing = Object.assign(new Error("no such file or directory"), {
            code: "ENOENT",
        });
        const deleteFile = vi.fn().mockRejectedValue(missing);

        await expect(
            deleteRecordingStorageArtifacts(
                storageWithDelete(deleteFile),
                "users/u/Meeting.ogg",
                "summary",
            ),
        ).resolves.toBeUndefined();
        expect(deleteFile).toHaveBeenCalledTimes(4);
    });

    it("surfaces real storage failures so cleanup can be retried", async () => {
        const deleteFile = vi
            .fn()
            .mockRejectedValue(new Error("S3 access denied"));

        await expect(
            deleteRecordingStorageArtifacts(
                storageWithDelete(deleteFile),
                "users/u/Meeting.ogg",
                "audio",
            ),
        ).rejects.toThrow("S3 access denied");
    });

    it("locks the task graph and removes whole-item task data after one deadlock retry", async () => {
        const selectLimit = vi
            .fn()
            .mockResolvedValue([{ storagePath: "users/u/Meeting.ogg" }]);
        const lockedSelectLimit = vi.fn().mockResolvedValue([
            {
                deletedAt: null,
                audioReapedAt: new Date(),
                contentReapedAt: new Date(),
                summaryReapedAt: new Date(),
            },
        ]);
        const tx = {
            select: vi.fn().mockReturnValue({
                from: vi.fn().mockReturnValue({
                    innerJoin: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            for: vi.fn().mockReturnValue({
                                limit: lockedSelectLimit,
                            }),
                        }),
                    }),
                }),
            }),
            update: vi.fn().mockReturnValue({
                set: vi.fn().mockReturnValue({
                    where: vi.fn().mockResolvedValue(undefined),
                }),
            }),
        };
        dbMock.select.mockReturnValue({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({ limit: selectLimit }),
            }),
        });
        dbMock.transaction
            .mockRejectedValueOnce(
                Object.assign(new Error("deadlock"), {
                    code: "40P01",
                }),
            )
            .mockImplementation(async (run: (executor: typeof tx) => unknown) =>
                run(tx),
            );

        await eraseLocalArtifact("u", "recording", "audio");

        expect(dbMock.transaction).toHaveBeenCalledTimes(2);
        expect(lockItemTaskGraphInTx).toHaveBeenCalledWith(tx, {
            itemId: "recording",
            ownerUserId: "u",
        });
        expect(deleteItemTaskDataInTx).toHaveBeenCalledWith(
            tx,
            expect.objectContaining({
                itemId: "recording",
                ownerUserId: "u",
                reason: "erased",
            }),
        );
    });
});
