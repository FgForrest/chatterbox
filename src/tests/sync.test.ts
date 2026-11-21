import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// A sync that replaces the audio demotes names on the transcripts it keeps
// (audio provenance); not what these tests are about.
vi.mock("@/lib/knowledge/transcript-rewrite", async (importOriginal) => ({
    ...(await importOriginal<
        typeof import("@/lib/knowledge/transcript-rewrite")
    >()),
    audioReplacedInTx: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
    env: {
        DEFAULT_STORAGE_TYPE: "local",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
}));

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        transaction: vi.fn(),
    },
}));

vi.mock("@/lib/plaud/client-factory", () => ({
    createPlaudClient: vi.fn(),
}));

const { resolveDefaultProfile } = vi.hoisted(() => ({
    resolveDefaultProfile: vi.fn(),
}));
vi.mock("@/lib/profiles/resolve", () => ({ resolveDefaultProfile }));

vi.mock("@/lib/audio/ingest-waveform", () => ({
    generateIngestWaveform: vi.fn().mockResolvedValue([0.25, 1]),
}));

vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        uploadFile: vi.fn().mockResolvedValue(undefined),
        downloadFile: vi.fn().mockResolvedValue(Buffer.from("audio-data")),
    }),
}));

vi.mock("@/lib/recordings/storage-reconciliation-job", () => ({
    enqueueStorageReconciliationJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/notifications/bark", () => ({
    sendNewRecordingBarkNotification: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/notifications/email", () => ({
    sendNewRecordingEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/transcription/transcription-job", () => ({
    enqueueTranscriptionJob: vi.fn().mockResolvedValue({
        job: { id: "job-1" },
        created: true,
    }),
}));

vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/pipeline/arrival", () => ({
    requestArrivalInTx: vi
        .fn()
        .mockResolvedValue({ requestedGeneration: 1, enqueued: true }),
    resolveArrivalProfile: vi.fn(),
}));
vi.mock("@/lib/pipeline/trigger", () => ({
    requestAdvanceInTx: vi.fn().mockResolvedValue({
        requestedGeneration: 1,
        enqueued: true,
    }),
}));

import { db } from "@/db";
import { chatterItems } from "@/db/schema";
import { generateIngestWaveform } from "@/lib/audio/ingest-waveform";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { requestArrivalInTx } from "@/lib/pipeline/arrival";
import { createPlaudClient } from "@/lib/plaud/client-factory";
import { captureServerException } from "@/lib/posthog-server";
import { syncRecordingsForUser } from "@/lib/sync/sync-recordings";
import { enqueueTranscriptionJob } from "@/lib/transcription/transcription-job";

/** The existing-recording lookup: the recording, joined to its item's markers. */
function existingRecordingLookup(recording: Record<string, unknown>) {
    const joined = {
        innerJoin: vi.fn(),
        where: vi.fn().mockReturnValue({
            limit: vi
                .fn()
                .mockResolvedValue([
                    { recording, contentReapedAt: null, summaryReapedAt: null },
                ]),
        }),
    };
    joined.innerJoin.mockReturnValue(joined);
    return { from: vi.fn().mockReturnValue(joined) };
}

describe("Sync", () => {
    const mockUserId = "user-123";

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("syncRecordingsForUser", () => {
        it("should return error when no Plaud connection found", async () => {
            (db.select as Mock).mockReturnValue({
                from: vi.fn().mockReturnValue({
                    where: vi.fn().mockReturnValue({
                        limit: vi.fn().mockResolvedValue([]),
                    }),
                }),
            });

            const result = await syncRecordingsForUser(mockUserId);

            expect(result.errors).toContain("No Plaud connection found");
            expect(result.newRecordings).toBe(0);
        });

        it("should skip already synced recordings with same version", async () => {
            const mockConnection = {
                id: "conn-1",
                userId: mockUserId,
                bearerToken: "encrypted-token",
            };

            const mockExistingRecording = {
                id: "local-rec-1",
                plaudFileId: "plaud-1",
                plaudVersion: "1000",
            };

            const mockPlaudRecordings = [
                {
                    id: "plaud-1",
                    filename: "Recording 1.mp3",
                    duration: 60000,
                    start_time: "2024-01-01T10:00:00Z",
                    end_time: "2024-01-01T10:01:00Z",
                    filesize: 1024000,
                    file_md5: "abc123",
                    serial_number: "SN123",
                    version_ms: 1000,
                    timezone: 0,
                    zonemins: 0,
                    scene: 0,
                    is_trash: false,
                },
            ];

            const mockPlaudClient = {
                getRecordings: vi.fn().mockResolvedValue({
                    data_file_list: mockPlaudRecordings,
                }),
                downloadRecording: vi
                    .fn()
                    .mockResolvedValue(Buffer.from("audio")),
            };

            (createPlaudClient as Mock).mockResolvedValue(mockPlaudClient);

            (db.select as Mock)
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi.fn().mockResolvedValue([mockConnection]),
                        }),
                    }),
                })
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi
                                .fn()
                                .mockResolvedValue([{ id: "settings-1" }]),
                        }),
                    }),
                })
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi
                                .fn()
                                .mockResolvedValue([
                                    { email: "test@example.com" },
                                ]),
                        }),
                    }),
                })
                .mockReturnValueOnce(
                    existingRecordingLookup(mockExistingRecording),
                );

            const result = await syncRecordingsForUser(mockUserId);

            expect(result.newRecordings).toBe(0);
            expect(result.updatedRecordings).toBe(0);
        });

        it("does not retry transcription directly for already-synced recordings", async () => {
            const mockConnection = {
                id: "conn-1",
                userId: mockUserId,
                bearerToken: "encrypted-token",
            };
            const mockExistingRecording = {
                id: "local-rec-1",
                plaudFileId: "plaud-1",
                plaudVersion: "1000",
            };
            const mockPlaudClient = {
                getRecordings: vi.fn().mockResolvedValue({
                    data_file_list: [
                        {
                            id: "plaud-1",
                            filename: "Recording 1.mp3",
                            duration: 60000,
                            start_time: "2024-01-01T10:00:00Z",
                            end_time: "2024-01-01T10:01:00Z",
                            filesize: 1024000,
                            file_md5: "abc123",
                            serial_number: "SN123",
                            version_ms: 1000,
                            timezone: 0,
                            zonemins: 0,
                            scene: 0,
                            is_trash: false,
                        },
                    ],
                }),
                downloadRecording: vi
                    .fn()
                    .mockResolvedValue(Buffer.from("audio")),
            };
            (createPlaudClient as Mock).mockResolvedValue(mockPlaudClient);
            (db.update as Mock).mockReturnValue({
                set: vi.fn().mockReturnValue({
                    where: vi.fn().mockResolvedValue(undefined),
                }),
            });

            (db.select as Mock)
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi.fn().mockResolvedValue([mockConnection]),
                        }),
                    }),
                })
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi
                                .fn()
                                .mockResolvedValue([{ id: "settings-1" }]),
                        }),
                    }),
                })
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi
                                .fn()
                                .mockResolvedValue([
                                    { email: "test@example.com" },
                                ]),
                        }),
                    }),
                })
                .mockReturnValueOnce(
                    existingRecordingLookup(mockExistingRecording),
                );

            await syncRecordingsForUser(mockUserId);

            expect(enqueueTranscriptionJob).not.toHaveBeenCalled();
        });

        it("leaves keep-both transcription scheduling to the pipeline", async () => {
            const mockPlaudClient = {
                getRecordings: vi.fn().mockResolvedValue({
                    data_file_list: [],
                }),
            };
            (createPlaudClient as Mock).mockResolvedValue(mockPlaudClient);
            (db.update as Mock).mockReturnValue({
                set: vi.fn().mockReturnValue({
                    where: vi.fn().mockResolvedValue(undefined),
                }),
            });
            (db.select as Mock)
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi.fn().mockResolvedValue([
                                {
                                    id: "conn-1",
                                    userId: mockUserId,
                                    bearerToken: "encrypted-token",
                                },
                            ]),
                        }),
                    }),
                })
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi
                                .fn()
                                .mockResolvedValue([{ id: "settings-1" }]),
                        }),
                    }),
                })
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi
                                .fn()
                                .mockResolvedValue([
                                    { email: "test@example.com" },
                                ]),
                        }),
                    }),
                });

            await syncRecordingsForUser(mockUserId);

            expect(enqueueTranscriptionJob).not.toHaveBeenCalled();
        });

        it("imports recordings without resolving processing profiles in sync", async () => {
            const mockConnection = {
                id: "conn-1",
                userId: mockUserId,
                bearerToken: "encrypted-token",
            };
            const mockPlaudRecordings = [
                {
                    id: "plaud-1",
                    filename: "Recording 1.mp3",
                    duration: 60000,
                    start_time: "2024-01-01T10:00:00Z",
                    end_time: "2024-01-01T10:01:00Z",
                    filesize: 1024000,
                    file_md5: "abc123",
                    serial_number: "SN123",
                    version_ms: 1000,
                    timezone: 0,
                    zonemins: 0,
                    scene: 0,
                    is_trash: false,
                },
            ];

            (createPlaudClient as Mock).mockResolvedValue({
                getRecordings: vi.fn().mockResolvedValue({
                    data_file_list: mockPlaudRecordings,
                }),
                downloadRecording: vi
                    .fn()
                    .mockResolvedValue(Buffer.from("audio")),
            });
            (db.update as Mock).mockReturnValue({
                set: vi.fn().mockReturnValue({
                    where: vi.fn().mockResolvedValue(undefined),
                }),
            });
            (db.transaction as Mock).mockImplementation(
                async (callback: (tx: unknown) => Promise<unknown>) =>
                    callback({
                        insert: vi.fn().mockReturnValue({
                            values: vi.fn().mockResolvedValue(undefined),
                        }),
                    }),
            );

            (db.select as Mock)
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi.fn().mockResolvedValue([mockConnection]),
                        }),
                    }),
                })
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi
                                .fn()
                                .mockResolvedValue([{ id: "settings-1" }]),
                        }),
                    }),
                })
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi
                                .fn()
                                .mockResolvedValue([
                                    { email: "test@example.com" },
                                ]),
                        }),
                    }),
                })
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        innerJoin: vi.fn().mockReturnValue({
                            where: vi.fn().mockReturnValue({
                                limit: vi.fn().mockResolvedValue([]),
                            }),
                        }),
                    }),
                });

            const consoleError = vi
                .spyOn(console, "error")
                .mockImplementation(() => undefined);
            try {
                const result = await syncRecordingsForUser(mockUserId);

                expect(result.newRecordings).toBe(1);
                expect(result.errors).toEqual([]);
                expect(enqueueTranscriptionJob).not.toHaveBeenCalled();
                expect(resolveDefaultProfile).not.toHaveBeenCalled();
                expect(consoleError).not.toHaveBeenCalled();
                expect(captureServerException).not.toHaveBeenCalled();
                expect(requestArrivalInTx).toHaveBeenCalledWith(
                    expect.anything(),
                    expect.objectContaining({
                        userId: mockUserId,
                    }),
                );
            } finally {
                consoleError.mockRestore();
            }
        });

        /**
         * Sync a recording Plaud reports a newer version of. `locked` is the
         * row the update re-reads under its lock.
         */
        async function syncNewerVersion(locked: Record<string, unknown>) {
            const mockConnection = {
                id: "conn-1",
                userId: mockUserId,
                bearerToken: "encrypted-token",
            };

            const mockExistingRecording = {
                id: "local-rec-1",
                plaudFileId: "plaud-1",
                plaudVersion: "500",
            };

            const mockPlaudRecordings = [
                {
                    id: "plaud-1",
                    filename: "Recording 1.mp3",
                    duration: 60000,
                    start_time: "2024-01-01T10:00:00Z",
                    end_time: "2024-01-01T10:01:00Z",
                    filesize: 1024000,
                    file_md5: "abc123",
                    serial_number: "SN123",
                    version_ms: 2000,
                    timezone: 0,
                    zonemins: 0,
                    scene: 0,
                    is_trash: false,
                },
            ];

            const mockPlaudClient = {
                getRecordings: vi.fn().mockResolvedValue({
                    data_file_list: mockPlaudRecordings,
                }),
                downloadRecording: vi
                    .fn()
                    .mockResolvedValue(Buffer.from("audio")),
            };

            (createPlaudClient as Mock).mockResolvedValue(mockPlaudClient);

            (db.select as Mock)
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi.fn().mockResolvedValue([mockConnection]),
                        }),
                    }),
                })
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi
                                .fn()
                                .mockResolvedValue([{ id: "settings-1" }]),
                        }),
                    }),
                })
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi
                                .fn()
                                .mockResolvedValue([
                                    { email: "test@example.com" },
                                ]),
                        }),
                    }),
                })
                .mockReturnValueOnce(
                    existingRecordingLookup(mockExistingRecording),
                );

            (db.update as Mock).mockReturnValue({
                set: vi.fn().mockReturnValue({
                    where: vi.fn().mockResolvedValue(undefined),
                }),
            });

            // sync-recordings now wraps the update path in a transaction
            // that re-checks the tombstone under FOR UPDATE before writing.
            // Stub the tx so the inner select returns a non-tombstoned row
            // and the inner update resolves; cb returns true so the caller
            // proceeds to emit `recording.updated`.
            const writes: {
                table: unknown;
                values: Record<string, unknown>;
            }[] = [];
            let table: unknown;
            const set = vi.fn((values: Record<string, unknown>) => {
                writes.push({ table, values });
                return { where: vi.fn().mockResolvedValue(undefined) };
            });
            (db.transaction as Mock).mockImplementation(
                async (cb: (tx: unknown) => Promise<boolean>) => {
                    const lockedRead = {
                        where: vi.fn().mockReturnValue({
                            for: vi.fn().mockReturnValue({
                                limit: vi.fn().mockResolvedValue([locked]),
                            }),
                        }),
                    };
                    const tx = {
                        select: vi.fn().mockReturnValue({
                            from: vi.fn().mockReturnValue({
                                innerJoin: vi.fn().mockReturnValue(lockedRead),
                            }),
                        }),
                        update: vi.fn((target: unknown) => {
                            table = target;
                            return { set };
                        }),
                    };
                    return cb(tx);
                },
            );

            const result = await syncRecordingsForUser(mockUserId);
            const itemWrite = writes.find(
                (write) => write.table === chatterItems,
            );
            return { result, set, itemWrite };
        }

        it("should update recordings with newer version", async () => {
            const { result, set, itemWrite } = await syncNewerVersion({
                deletedAt: null,
            });

            expect(result.newRecordings).toBe(0);
            expect(result.updatedRecordings).toBe(1);
            expect(generateIngestWaveform).toHaveBeenCalledWith(
                Buffer.from("audio"),
            );
            expect(set).toHaveBeenCalledWith(
                expect.objectContaining({ waveformPeaks: [0.25, 1] }),
            );
            // A machine's title follows Plaud's filename.
            expect(decryptText(itemWrite?.values.title as string)).toBe(
                "Recording 1.mp3",
            );
        });

        it("keeps a title a person set over Plaud's filename", async () => {
            const { result, set, itemWrite } = await syncNewerVersion({
                deletedAt: null,
                titleEditedAt: new Date("2026-09-01T10:00:00Z"),
            });

            expect(result.updatedRecordings).toBe(1);
            expect(set).toHaveBeenCalledWith(
                expect.objectContaining({ waveformPeaks: [0.25, 1] }),
            );
            // The item is still updated, but its title is left as it is.
            expect(itemWrite).toBeDefined();
            expect(itemWrite?.values).not.toHaveProperty("title");
        });

        it("should return error when sync fails", async () => {
            const mockConnection = {
                id: "conn-1",
                userId: mockUserId,
                bearerToken: "encrypted-token",
            };

            (db.select as Mock)
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi.fn().mockResolvedValue([mockConnection]),
                        }),
                    }),
                })
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi
                                .fn()
                                .mockResolvedValue([{ id: "settings-1" }]),
                        }),
                    }),
                })
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi
                                .fn()
                                .mockResolvedValue([
                                    { email: "test@example.com" },
                                ]),
                        }),
                    }),
                });

            (createPlaudClient as Mock).mockRejectedValue(
                new Error("Connection failed"),
            );

            const result = await syncRecordingsForUser(mockUserId);

            expect(result.errors.length).toBeGreaterThan(0);
        });

        it.each([
            { code: undefined, message: "An unexpected error occurred" },
            {
                code: ErrorCode.PLAUD_API_ERROR,
                message: "Plaud could not complete the request.",
            },
            {
                code: ErrorCode.PLAUD_WORKSPACE_UNAVAILABLE,
                message: "Plaud could not complete the request.",
            },
        ])("reports a safe per-recording sync failure for $code", async ({
            code,
            message,
        }) => {
            const sensitiveFilename = "Confidential Client Deposition.mp3";
            const signature = "test-secret-signature";
            const rawMessage = `Download failed for https://example.com/audio?X-Amz-Signature=${signature}`;
            const downloadError = code
                ? new AppError(code, rawMessage, 400)
                : new Error(rawMessage);

            const mockConnection = {
                id: "conn-1",
                userId: mockUserId,
                bearerToken: "encrypted-token",
            };
            const mockExistingRecording = {
                id: "local-rec-1",
                plaudFileId: "plaud-1",
                plaudVersion: "500",
            };
            const mockPlaudRecordings = [
                {
                    id: "plaud-1",
                    filename: sensitiveFilename,
                    duration: 60000,
                    start_time: "2024-01-01T10:00:00Z",
                    end_time: "2024-01-01T10:01:00Z",
                    filesize: 1024000,
                    file_md5: "abc123",
                    serial_number: "SN123",
                    version_ms: 2000,
                    timezone: 0,
                    zonemins: 0,
                    scene: 0,
                    is_trash: false,
                },
            ];

            const mockPlaudClient = {
                getRecordings: vi.fn().mockResolvedValue({
                    data_file_list: mockPlaudRecordings,
                }),
                downloadRecording: vi.fn().mockRejectedValue(downloadError),
            };
            (createPlaudClient as Mock).mockResolvedValue(mockPlaudClient);
            (db.update as Mock).mockReturnValue({
                set: vi.fn().mockReturnValue({
                    where: vi.fn().mockResolvedValue(undefined),
                }),
            });

            (db.select as Mock)
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi.fn().mockResolvedValue([mockConnection]),
                        }),
                    }),
                })
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi
                                .fn()
                                .mockResolvedValue([{ id: "settings-1" }]),
                        }),
                    }),
                })
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi
                                .fn()
                                .mockResolvedValue([
                                    { email: "test@example.com" },
                                ]),
                        }),
                    }),
                })
                .mockReturnValueOnce(
                    existingRecordingLookup(mockExistingRecording),
                );

            const consoleError = vi
                .spyOn(console, "error")
                .mockImplementation(() => undefined);
            try {
                const result = await syncRecordingsForUser(mockUserId);

                expect(result.errors).toEqual([
                    `Failed to sync ${sensitiveFilename}: ${message}`,
                ]);
                expect(result.errors.join(" ")).not.toContain(signature);
                expect(consoleError).toHaveBeenCalledExactlyOnceWith(
                    "[sync] Failed to sync Plaud recording plaud-1:",
                    downloadError,
                );
            } finally {
                consoleError.mockRestore();
            }

            expect(captureServerException).toHaveBeenCalledTimes(1);
            const [capturedError] = (captureServerException as Mock).mock
                .calls[0] as [Error, Record<string, unknown>];
            expect(capturedError.message).not.toContain(sensitiveFilename);
            expect(capturedError.message).toBe(
                "Sync completed with 1 error(s)",
            );
        });
    });
});
