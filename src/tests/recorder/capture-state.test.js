import { afterEach, describe, expect, it, vi } from "vitest";
import {
    attachSession,
    confirmCaptureChunk,
    createCapture,
    deleteCapture,
    listPendingCaptures,
    markStopped,
    onCaptureChunk,
    retainCaptureCleanup,
    sessionForIntent,
    withCapture,
} from "../../../extensions/recorder/lib/capture-state.js";
import {
    createLocalSession,
    listChunkIndices,
    readLocalMeta,
    writeCaptureSealing,
    writeCaptureStop,
    writeChunk,
} from "../../../extensions/recorder/lib/chunk-store.js";

function notFound() {
    return new DOMException("Missing entry", "NotFoundError");
}

function opfs() {
    let failClose = false;
    let pausedWrite;
    const locks = new Map();
    function directory() {
        const entries = new Map();
        function open(name, create, factory) {
            if (!entries.has(name) && create) entries.set(name, factory());
            if (!entries.has(name)) throw notFound();
            return entries.get(name);
        }
        return {
            kind: "directory",
            entries: async function* () {
                yield* entries;
            },
            getDirectoryHandle: async (name, { create } = {}) =>
                open(name, create, directory),
            getFileHandle: async (name, { create } = {}) =>
                open(name, create, () => {
                    let data = "";
                    return {
                        kind: "file",
                        getFile: async () => new File([data], name),
                        createWritable: async () => {
                            let next;
                            return {
                                write: async (value) => {
                                    next = value;
                                },
                                close: async () => {
                                    if (failClose && name === "meta.json") {
                                        failClose = false;
                                        throw new Error(
                                            "Interrupted before commit",
                                        );
                                    }
                                    if (pausedWrite && name === "meta.json") {
                                        const { entered, finish } = pausedWrite;
                                        pausedWrite = null;
                                        entered.resolve();
                                        await finish.promise;
                                    }
                                    data = next;
                                },
                                abort: async () => {},
                            };
                        },
                    };
                }),
            removeEntry: async (name) => {
                if (!entries.delete(name)) throw notFound();
            },
        };
    }
    const root = directory();
    vi.stubGlobal("navigator", {
        storage: { getDirectory: async () => root },
        locks: {
            request: (name, work) => {
                const next = (locks.get(name) ?? Promise.resolve())
                    .catch(() => {})
                    .then(work);
                locks.set(name, next);
                return next;
            },
        },
    });
    return {
        pauseMetaWrite() {
            pausedWrite = {
                entered: Promise.withResolvers(),
                finish: Promise.withResolvers(),
            };
            return pausedWrite;
        },
        interruptMetaWrite: () => {
            failClose = true;
        },
    };
}

function cipher() {
    const bytes = new Uint8Array(30);
    bytes[0] = 1;
    return new Blob([bytes], { type: "application/octet-stream" });
}

afterEach(() => vi.unstubAllGlobals());

describe("capture metadata in OPFS", () => {
    it("migrates a released server-keyed directory in place and retains the verified prefix", async () => {
        opfs();
        await createLocalSession("old-server-id", {
            clientRecordingId: "old-client-id",
            startedAt: "2026-10-21T11:12:13.000Z",
            serverUrl: "https://recorder.example",
        });
        await writeChunk("old-server-id", 0, cipher());
        await writeChunk("old-server-id", 2, cipher());
        const migrated = await readLocalMeta("old-server-id");
        expect(migrated).toMatchObject({
            captureId: "old-server-id",
            clientRecordingId: "old-client-id",
            serverSessionId: "old-server-id",
            protocol: 1,
            verifiedPrefix: 0,
            highestCommittedIndex: 2,
        });
        expect(await readLocalMeta("old-server-id")).toEqual(migrated);
        expect(await listChunkIndices("old-server-id", true)).toEqual([0, 2]);
        expect((await listPendingCaptures()).map(({ id }) => id)).toEqual([
            "old-server-id",
        ]);
    });

    it("finds the highest committed index in an already migrated buffer", async () => {
        opfs();
        const captureId = "migrated";
        await createLocalSession(captureId, {
            captureId,
            protocol: 1,
            verifiedPrefix: 0,
            chunkCount: 1,
        });
        await writeChunk(captureId, 0, cipher());
        await writeChunk(captureId, 2, cipher());
        expect(await readLocalMeta(captureId)).toMatchObject({
            verifiedPrefix: 0,
            highestCommittedIndex: 2,
        });
    });

    it("keeps only cancellation metadata after deleting discarded audio", async () => {
        opfs();
        const { captureId } = await createCapture({
            protocol: 2,
            createIntent: { startedAt: "2026-11-28T10:00:00Z" },
            agendaTitle: "Private agenda",
        });
        const sealing = { protocol: 2, kid: "public-key-id" };
        await writeCaptureSealing(captureId, sealing);
        await writeChunk(captureId, 0, cipher());
        await attachSession(captureId, "old-session");
        expect(await readLocalMeta(captureId)).not.toHaveProperty(
            "agendaTitle",
        );
        await retainCaptureCleanup(captureId);
        expect(await listChunkIndices(captureId)).toEqual([]);
        expect(await readLocalMeta(captureId)).toMatchObject({
            cleanupPending: true,
            sealing,
            serverSessionId: "old-session",
        });
        expect(await attachSession(captureId, "late-session")).toBeNull();
    });

    it("retries an interrupted in-place migration without duplicating or dropping chunks", async () => {
        const disk = opfs();
        await createLocalSession("released-buffer", {
            serverSessionId: "replacement-session",
        });
        await writeChunk("released-buffer", 0, cipher());
        disk.interruptMetaWrite();

        await expect(readLocalMeta("released-buffer")).rejects.toThrow(
            "Interrupted before commit",
        );
        const copies = await Promise.all([
            readLocalMeta("released-buffer"),
            readLocalMeta("released-buffer"),
        ]);
        expect(copies[0]).toEqual(copies[1]);
        expect(copies[0]).toMatchObject({
            captureId: "released-buffer",
            serverSessionId: "replacement-session",
            verifiedPrefix: 0,
        });
        expect(await listPendingCaptures()).toHaveLength(1);
        expect(await listChunkIndices("released-buffer", true)).toEqual([0]);
    });

    it("preserves an explicit null binding and accepts only encrypted chunks", async () => {
        opfs();
        await createLocalSession("unattached", { serverSessionId: null });
        expect(await readLocalMeta("unattached")).toMatchObject({
            captureId: "unattached",
            serverSessionId: null,
        });
        const { captureId } = await createCapture({
            clientRecordingId: "client-id",
            startedAt: "2026-10-21T11:12:13.000Z",
            protocol: 2,
            pairing: {
                serverOrigin: "https://recorder.example",
                accountId: "account",
            },
        });
        await expect(
            writeChunk(captureId, 0, new Blob(["plaintext"])),
        ).rejects.toThrow("Invalid encrypted recording chunk");
        const listener = vi.fn();
        const unsubscribe = onCaptureChunk(captureId, listener);
        await writeChunk(captureId, 0, cipher());
        await confirmCaptureChunk(captureId, 0);
        unsubscribe();
        await writeChunk(captureId, 2, cipher());
        await confirmCaptureChunk(captureId, 2);
        expect(listener).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                detail: { captureId, index: 0 },
            }),
        );
        await writeCaptureSealing(captureId, {
            protocol: 2,
            kid: "public-key-id",
        });
        await withCapture(captureId, () =>
            attachSession(captureId, "server-id"),
        );
        const stop = await markStopped(captureId, {
            stopReason: "browser-closed",
        });
        expect(stop).toMatchObject({
            captureId,
            serverSessionId: "server-id",
            protocol: 2,
            sealing: { protocol: 2, kid: "public-key-id" },
            verifiedPrefix: 0,
            highestCommittedIndex: 2,
            chunkCount: 3,
            stoppedAt: expect.any(String),
        });
        expect(await readLocalMeta(captureId)).toMatchObject(stop);
    });

    it("serializes host Stop and metadata reads with a committed worker write", async () => {
        const disk = opfs();
        const { captureId } = await createCapture({ protocol: 2 });
        const { entered, finish } = disk.pauseMetaWrite();
        const write = createLocalSession(captureId, {
            captureId,
            protocol: 2,
            verifiedPrefix: 1,
        });
        await entered.promise;
        const stop = writeCaptureStop(captureId, {
            stoppedAt: "2026-11-28T10:00:00Z",
        });
        const read = readLocalMeta(captureId);
        finish.resolve();
        await Promise.all([write, stop]);
        expect(await read).toMatchObject({
            verifiedPrefix: 1,
            stoppedAt: "2026-11-28T10:00:00Z",
        });
    });

    it("serializes Stop, complete, and Discard on one capture while another can progress", async () => {
        opfs();
        const { captureId } = await createCapture({
            clientRecordingId: "client-id",
        });
        const gate = Promise.withResolvers();
        const stopped = withCapture(captureId, async () => {
            await gate.promise;
            await markStopped(captureId, { stopReason: "user", chunkCount: 0 });
        });
        const completed = withCapture(captureId, async () => {
            expect((await readLocalMeta(captureId)).stoppedAt).toBeTruthy();
            await attachSession(captureId, "server-id");
        });
        const discarded = withCapture(captureId, async () => {
            expect((await readLocalMeta(captureId)).serverSessionId).toBe(
                "server-id",
            );
            await deleteCapture(captureId);
        });
        await expect(withCapture("other-capture", () => "ready")).resolves.toBe(
            "ready",
        );
        expect((await readLocalMeta(captureId)).stoppedAt).toBeNull();
        gate.resolve();
        await Promise.all([stopped, completed, discarded]);
        expect(await readLocalMeta(captureId)).toBeNull();
    });
});

describe("create intent in a released server's session list", () => {
    const intent = {
        clientVersion: "0.10.0+client-id",
        startedAt: "2026-11-28T10:00:00.000Z",
    };

    it("matches only the same client version at the same instant", () => {
        const match = {
            id: "match",
            started_at: "2026-11-28T11:00:00+01:00",
            metadata: { clientVersion: intent.clientVersion },
        };
        const sessions = [
            {
                id: "other-version",
                started_at: intent.startedAt,
                metadata: { clientVersion: "0.10.0+other-id" },
            },
            {
                id: "other-instant",
                started_at: "2026-11-28T10:00:00.001Z",
                metadata: { clientVersion: intent.clientVersion },
            },
            { id: "no-metadata", started_at: intent.startedAt },
            match,
        ];

        expect(sessionForIntent(sessions, intent)).toBe(match);
        expect(sessionForIntent(sessions.slice(0, 3), intent)).toBeUndefined();
    });
});
