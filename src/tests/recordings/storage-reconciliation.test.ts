import { beforeEach, describe, expect, it, vi } from "vitest";
import { asyncJobs } from "@/db/schema";

const mocks = vi.hoisted(() => ({
    copyExistingRecordingFiles: vi.fn(),
    createUserStorageProvider: vi.fn(),
    deleteOldRecordingFiles: vi.fn(),
    exists: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
    lookup: vi.fn(),
    activeCut: null as { id: string } | null,
    lockedCut: null as { id: string } | null,
    inTransaction: false,
    locked: {
        storagePath: "user-1/legacy.mp3",
        storageFilename: null as string | null,
        cutAt: null as Date | null,
    },
}));

vi.mock("@/db", () => ({
    db: {
        select: mocks.select,
        update: mocks.update,
        transaction: mocks.transaction,
    },
}));
vi.mock("@/lib/recordings/storage-files", () => ({
    copyExistingRecordingFiles: mocks.copyExistingRecordingFiles,
    deleteOldRecordingFiles: mocks.deleteOldRecordingFiles,
    sidecarKey: (path: string, kind: string) =>
        `${path.replace(/\.[^.]+$/, "")}.${kind}.md`,
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: mocks.createUserStorageProvider,
}));

import {
    reconcileRecordingStorage,
    recordingStorageNeedsReconciliation,
    storageFilenameMatchesTitle,
} from "@/lib/recordings/reconcile-storage";

function selection(result: unknown[]) {
    return {
        from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(result),
            }),
        }),
    };
}

function state(
    overrides: Partial<{
        id: string;
        userId: string;
        title: string;
        storagePath: string;
        storageFilename: string | null;
    }> = {},
) {
    mocks.locked = {
        storagePath: overrides.storagePath ?? "user-1/legacy.mp3",
        storageFilename: overrides.storageFilename ?? null,
        cutAt: null,
    };
    return {
        id: "rec-1",
        userId: "user-1",
        title: "Board meeting",
        storagePath: "user-1/legacy.mp3",
        storageFilename: null,
        ...overrides,
    };
}

describe("recording storage reconciliation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.activeCut = null;
        mocks.lockedCut = null;
        mocks.inTransaction = false;
        mocks.exists.mockImplementation(async () => {
            expect(mocks.inTransaction).toBe(false);
            return false;
        });
        mocks.createUserStorageProvider.mockResolvedValue({
            exists: mocks.exists,
        });
        mocks.copyExistingRecordingFiles.mockResolvedValue([
            "user-1/legacy.mp3",
            "user-1/legacy.transcript.md",
        ]);
        mocks.deleteOldRecordingFiles.mockResolvedValue(undefined);
        mocks.lookup.mockReturnValue(selection([]));
        mocks.select.mockImplementation((columns: Record<string, unknown>) => ({
            from: (table: unknown) => {
                if ("storagePath" in columns)
                    return selection([{ ...mocks.locked }]).from();
                if (table === asyncJobs)
                    return selection(
                        mocks.activeCut ? [mocks.activeCut] : [],
                    ).from();
                return mocks.lookup(columns).from();
            },
        }));
        mocks.transaction.mockImplementation(
            async (run: (tx: unknown) => Promise<unknown>) => {
                mocks.inTransaction = true;
                try {
                    return await run({
                        select: (columns: Record<string, unknown>) => ({
                            from: () => ({
                                where: () =>
                                    "storagePath" in columns
                                        ? {
                                              for: async () => [
                                                  { ...mocks.locked },
                                              ],
                                          }
                                        : {
                                              limit: async () =>
                                                  mocks.lockedCut
                                                      ? [mocks.lockedCut]
                                                      : [],
                                          },
                            }),
                        }),
                        update: mocks.update,
                    });
                } finally {
                    mocks.inTransaction = false;
                }
            },
        );
        mocks.update.mockImplementation(() => ({
            set: vi
                .fn()
                .mockImplementation((values: Record<string, unknown>) => {
                    if (typeof values.storageFilename === "string")
                        mocks.locked.storageFilename = values.storageFilename;
                    return {
                        where: vi.fn().mockReturnValue({
                            returning: vi.fn().mockResolvedValue([
                                "storageFilename" in values
                                    ? {
                                          storageFilename:
                                              values.storageFilename,
                                      }
                                    : { storagePath: values.storagePath },
                            ]),
                        }),
                    };
                }),
        }));
    });

    it("recognizes a readable reserved filename and its collision suffix", () => {
        expect(
            recordingStorageNeedsReconciliation(
                state({
                    storagePath: "user-1/Board_meeting.mp3",
                    storageFilename: "Board_meeting.mp3",
                }),
            ),
        ).toBe(false);
        expect(
            storageFilenameMatchesTitle(
                "Board_meeting-1.mp3",
                "Board meeting",
                "mp3",
            ),
        ).toBe(true);
        expect(recordingStorageNeedsReconciliation(state())).toBe(true);
    });

    it("reserves a readable name, moves files, and updates storage_path", async () => {
        const storage = { exists: mocks.exists };
        mocks.createUserStorageProvider.mockResolvedValue(storage);
        mocks.copyExistingRecordingFiles.mockImplementation(async () => {
            expect(mocks.inTransaction).toBe(false);
            expect(mocks.transaction).not.toHaveBeenCalled();
            return ["user-1/legacy.mp3", "user-1/legacy.transcript.md"];
        });

        await expect(reconcileRecordingStorage(state())).resolves.toEqual({
            changed: true,
            storagePath: "user-1/Board_meeting.mp3",
            storageFilename: "Board_meeting.mp3",
        });

        expect(mocks.copyExistingRecordingFiles).toHaveBeenCalledWith(
            storage,
            "user-1/legacy.mp3",
            "user-1/Board_meeting.mp3",
        );
        expect(mocks.deleteOldRecordingFiles).toHaveBeenCalledWith(
            storage,
            ["user-1/legacy.mp3", "user-1/legacy.transcript.md"],
            "rec-1",
        );
    });

    it("adds a numeric suffix when the readable name is owned", async () => {
        mocks.lookup
            .mockReturnValueOnce(selection([{ id: "rec-2" }]))
            .mockReturnValue(selection([]));

        await expect(reconcileRecordingStorage(state())).resolves.toMatchObject(
            {
                storagePath: "user-1/Board_meeting-1.mp3",
                storageFilename: "Board_meeting-1.mp3",
            },
        );
    });

    it("retries with a suffix after a concurrent stem reservation", async () => {
        const conflict = Object.assign(new Error("duplicate key"), {
            code: "23505",
            constraint: "recordings_user_id_storage_filename_stem_unique",
        });
        let reservationAttempts = 0;
        mocks.update.mockImplementation(() => ({
            set: vi
                .fn()
                .mockImplementation((values: Record<string, unknown>) => ({
                    where: vi.fn().mockReturnValue({
                        returning: vi.fn().mockImplementation(() => {
                            if (
                                "storageFilename" in values &&
                                reservationAttempts++ === 0
                            ) {
                                return Promise.reject(conflict);
                            }
                            if (typeof values.storageFilename === "string")
                                mocks.locked.storageFilename =
                                    values.storageFilename;
                            return Promise.resolve([
                                "storageFilename" in values
                                    ? {
                                          storageFilename:
                                              values.storageFilename,
                                      }
                                    : { storagePath: values.storagePath },
                            ]);
                        }),
                    }),
                })),
        }));

        await expect(reconcileRecordingStorage(state())).resolves.toMatchObject(
            {
                storagePath: "user-1/Board_meeting-1.mp3",
                storageFilename: "Board_meeting-1.mp3",
            },
        );
    });

    it("does not delete a legacy key still referenced by another recording", async () => {
        mocks.lookup
            .mockReturnValueOnce(selection([]))
            .mockReturnValueOnce(selection([{ id: "rec-2" }]));

        await reconcileRecordingStorage(state());

        expect(mocks.deleteOldRecordingFiles).not.toHaveBeenCalled();
    });

    it("defers an active cut before accessing storage or taking a lock", async () => {
        mocks.activeCut = { id: "cut-job" };
        await expect(reconcileRecordingStorage(state())).resolves.toEqual({
            deferred: true,
            changed: false,
            storagePath: "user-1/legacy.mp3",
            storageFilename: "",
        });
        expect(mocks.createUserStorageProvider).not.toHaveBeenCalled();
        expect(mocks.exists).not.toHaveBeenCalled();
        expect(mocks.copyExistingRecordingFiles).not.toHaveBeenCalled();
        expect(mocks.deleteOldRecordingFiles).not.toHaveBeenCalled();
        expect(mocks.update).not.toHaveBeenCalled();
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it("defers a stale input path before accessing storage", async () => {
        const input = state();
        mocks.locked.storagePath = "user-1/.cuts/cut-job/Board_meeting.mp3";
        await expect(reconcileRecordingStorage(input)).resolves.toMatchObject({
            deferred: true,
            changed: false,
            storagePath: mocks.locked.storagePath,
        });
        expect(mocks.createUserStorageProvider).not.toHaveBeenCalled();
        expect(mocks.update).not.toHaveBeenCalled();
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it.each([
        "path changed",
        "cut started",
        "cut marker changed",
    ])("removes only the new copy when the post-copy check fails: %s", async (race) => {
        const input = state();
        mocks.copyExistingRecordingFiles.mockImplementation(async () => {
            expect(mocks.inTransaction).toBe(false);
            if (race === "path changed")
                mocks.locked.storagePath =
                    "user-1/.cuts/cut-job/Board_meeting.mp3";
            else if (race === "cut started")
                mocks.lockedCut = { id: "cut-job" };
            else mocks.locked.cutAt = new Date("2026-11-03T12:00:00Z");
            return ["user-1/legacy.mp3", "user-1/legacy.transcript.md"];
        });
        await expect(reconcileRecordingStorage(input)).resolves.toMatchObject({
            deferred: true,
            changed: false,
            storagePath:
                race === "path changed"
                    ? "user-1/.cuts/cut-job/Board_meeting.mp3"
                    : input.storagePath,
        });
        expect(mocks.update).toHaveBeenCalledTimes(1);
        expect(mocks.deleteOldRecordingFiles).toHaveBeenCalledExactlyOnceWith(
            { exists: mocks.exists },
            ["user-1/Board_meeting.mp3", "user-1/Board_meeting.transcript.md"],
            "rec-1",
        );
    });

    it("updates an empty tracked path without probing unsafe root sidecars", async () => {
        await reconcileRecordingStorage(state({ storagePath: "" }));

        expect(mocks.copyExistingRecordingFiles).not.toHaveBeenCalled();
        expect(mocks.update).toHaveBeenCalledTimes(2);
    });
});
