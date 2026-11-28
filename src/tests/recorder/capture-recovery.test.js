import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    extension,
    h,
    message,
    offscreen,
    startFromPopup,
} from "./meeting-worker-fixture.js";

const options = {
    ...extension,
    url: "chrome-extension://test/options/options.html",
};
const serverUrl = "https://recorder.example";
const startedAt = "2026-10-21T11:12:13.000Z";
const intent = {
    clientRecordingId: "2a5841c6-fa60-4133-be6c-0972dd64846f",
    clientVersion: "0.9.11+2a5841c6-fa60-4133-be6c-0972dd64846f",
    startedAt,
};
const pairing = (connectionId = "1.2.3", accountId = null) => ({
    serverOrigin: serverUrl,
    accountId,
    connectionId,
});

function durable(captureId, patch = {}) {
    const value = {
        captureId,
        serverUrl,
        pairing: pairing(),
        startedAt,
        stoppedAt: "2026-10-21T12:12:13.000Z",
        protocol: 1,
        verifiedPrefix: 0,
        chunkCount: 1,
        serverSessionId: `server-${captureId}`,
        createOutcome: "attached",
        ...patch,
    };
    h.metas.set(captureId, value);
    return value;
}

function live(captureMode = "tab") {
    h.session.recordingState = {
        captureId: "live",
        bufferId: "live",
        sessionId: "server-live",
        captureMode,
        captureWindowId: captureMode === "desktop" ? 77 : null,
        pickerRequestId: captureMode === "desktop" ? "picker-one" : null,
        state: "recording",
        startedAt,
        stopped: false,
        uploaded: [],
        chunkCount: 0,
    };
    durable("live", { stoppedAt: null, verifiedPrefix: -1, chunkCount: 0 });
}

beforeEach(() => {
    h.local.encryptedApiKey = { nonce: [1, 2, 3] };
    h.listLocalSessions.mockImplementation(async () => [...h.metas.keys()]);
    h.listChunkIndices.mockResolvedValue([0]);
    h.listRecordingSessions.mockResolvedValue([]);
    h.getSession.mockImplementation(async (_auth, id) => ({
        id,
        status: "open",
        received_chunks: [],
    }));
    h.completeSession.mockResolvedValue({ job_id: "job-one" });
    chrome.runtime.sendMessage.mockImplementation(async () => ({ ok: true }));
    chrome.runtime.getContexts.mockResolvedValue([]);
});

describe("capture worker recovery", () => {
    it.each([
        "tab",
        "desktop",
    ])("reattaches to the matching %s host after wake", async (mode) => {
        live(mode);
        chrome.runtime.sendMessage.mockImplementation(async (request) =>
            request.type === "ping"
                ? { ok: true, captureId: "live" }
                : { ok: true },
        );
        expect(
            (await message({ type: "get-state" }, extension)).state,
        ).toMatchObject({
            captureId: "live",
            stopped: false,
        });
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "ping",
                target: mode === "tab" ? "offscreen" : "desktop-recorder",
                payload: { captureId: "live" },
            }),
        );
        expect(h.metas.get("live").stoppedAt).toBeNull();
    });

    it("reissues a durable Stop when the worker was replaced before sending it", async () => {
        live();
        Object.assign(h.metas.get("live"), {
            stopRequestedAt: startedAt,
            stopReason: "user",
        });
        chrome.runtime.sendMessage.mockImplementation(async (request) =>
            request.type === "ping"
                ? { ok: true, captureId: "live" }
                : { ok: true },
        );
        expect(
            (await message({ type: "get-state" }, extension)).state,
        ).toMatchObject({
            captureId: "live",
            captureStopping: true,
            stopReason: "user",
        });
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                target: "offscreen",
                type: "stop",
                payload: { captureId: "live" },
            }),
        );
    });

    it("cleans an empty capture on wake when its cancelled host no longer reports ownership", async () => {
        live();
        h.listChunkIndices.mockResolvedValue([]);
        Object.assign(h.metas.get("live"), {
            stopRequestedAt: startedAt,
            stopReason: "user",
        });
        chrome.runtime.sendMessage.mockImplementation(async (request) =>
            request.type === "ping"
                ? { ok: true, captureId: null }
                : { ok: true },
        );
        expect(
            (await message({ type: "get-state" }, extension)).state.state,
        ).toBe("idle");
        expect(h.abortSession).toHaveBeenCalledExactlyOnceWith(
            expect.anything(),
            "server-live",
        );
        expect(h.metas.has("live")).toBe(false);
    });

    it("keeps Stop retryable when its matching host is still active", async () => {
        live();
        const deliver = vi
            .fn()
            .mockResolvedValueOnce({ ok: false })
            .mockResolvedValueOnce({ ok: true });
        chrome.runtime.sendMessage.mockImplementation(async (request) => {
            if (request.type === "ping") return { captureId: "live" };
            return request.type === "stop" ? deliver() : { ok: true };
        });
        const stop = () =>
            message({ type: "stop-recording", captureId: "live" }, extension);
        expect(await stop()).toMatchObject({ ok: false });
        expect(h.metas.get("live")).toMatchObject({
            stoppedAt: null,
            stopRequestedAt: null,
        });
        expect(h.session.recordingState).toMatchObject({
            stopped: false,
            captureStopping: false,
        });
        expect(await stop()).toEqual({ ok: true });
        expect(deliver).toHaveBeenCalledTimes(2);
    });

    it.each([
        "tab",
        "desktop",
    ])("keeps the gap when an existing %s host owns a different capture", async (mode) => {
        live(mode);
        chrome.runtime.getContexts.mockResolvedValue([
            { contextType: "OFFSCREEN_DOCUMENT" },
        ]);
        h.listChunkIndices.mockResolvedValue([0, 2]);
        chrome.runtime.sendMessage.mockImplementation(async (request) =>
            request.type === "ping"
                ? { ok: true, captureId: "another-capture" }
                : { ok: true },
        );
        expect(
            (await message({ type: "get-state" }, extension)).state,
        ).toMatchObject({
            captureId: "live",
            stopped: true,
            stopReason: "browser-closed",
            chunkCount: 3,
        });
        expect(h.metas.get("live")).toMatchObject({
            stoppedAt: expect.any(String),
            verifiedPrefix: 0,
            highestCommittedIndex: 2,
        });
        expect(h.completeSession).not.toHaveBeenCalled();
        expect(chrome.notifications.create).toHaveBeenCalledWith(
            undefined,
            expect.objectContaining({ title: "recordingStopped" }),
        );
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "stop" }),
        );
        expect(chrome.offscreen.closeDocument).not.toHaveBeenCalled();
        expect(chrome.windows.remove).not.toHaveBeenCalled();
    });

    it.each([
        true,
        false,
    ])("reconciles an unknown create before Discard (server has it: %s)", async (exists) => {
        durable("unknown", {
            serverSessionId: null,
            createIntent: intent,
            createOutcome: "unknown",
        });
        if (exists)
            h.listRecordingSessions.mockResolvedValue([
                {
                    id: "existing-server-session",
                    started_at: startedAt,
                    metadata: { clientVersion: intent.clientVersion },
                },
            ]);
        h.abortSession.mockImplementationOnce(async () => {
            expect(h.metas.has("unknown")).toBe(true);
        });
        expect(
            await message(
                { type: "discard-buffer", bufferId: "unknown" },
                options,
            ),
        ).toEqual({ ok: true });
        expect(h.listRecordingSessions).toHaveBeenCalledOnce();
        if (exists) expect(h.createSession).not.toHaveBeenCalled();
        else
            expect(h.createSession).toHaveBeenCalledExactlyOnceWith(
                expect.anything(),
                intent,
            );
        expect(h.abortSession).toHaveBeenCalledExactlyOnceWith(
            expect.anything(),
            exists ? "existing-server-session" : "session-1",
        );
        expect(h.metas.has("unknown")).toBe(false);
    });

    it("lists again when the original Create commits after the first lookup", async () => {
        durable("unknown", {
            serverSessionId: null,
            createIntent: intent,
            createOutcome: "unknown",
        });
        h.listRecordingSessions
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                {
                    id: "original-session",
                    started_at: startedAt,
                    metadata: { clientVersion: intent.clientVersion },
                },
            ]);
        h.createSession.mockRejectedValueOnce(
            Object.assign(new Error("Already created"), { status: 409 }),
        );
        expect(
            await message(
                { type: "discard-buffer", bufferId: "unknown" },
                options,
            ),
        ).toEqual({ ok: true });
        expect(h.listRecordingSessions).toHaveBeenCalledTimes(2);
        expect(h.abortSession).toHaveBeenCalledExactlyOnceWith(
            expect.anything(),
            "original-session",
        );
    });

    it("retains an uncertain create when a replacement credential cannot verify it", async () => {
        durable("unknown", {
            pairing: pairing("old"),
            serverSessionId: null,
            createIntent: intent,
            createOutcome: "unknown",
        });
        expect(
            await message(
                { type: "discard-buffer", bufferId: "unknown" },
                options,
            ),
        ).toMatchObject({ ok: false });
        expect(h.listRecordingSessions).toHaveBeenCalledOnce();
        expect(h.createSession).not.toHaveBeenCalled();
        expect(h.abortSession).not.toHaveBeenCalled();
        expect(h.metas.has("unknown")).toBe(true);
    });

    it("remembers a Stop received while Create is in flight and never starts the cancelled host", async () => {
        h.listChunkIndices.mockResolvedValue([]);
        const create = Promise.withResolvers();
        h.createSession.mockImplementationOnce(async () => {
            const meta = [...h.metas.values()][0];
            expect(meta).toMatchObject({
                serverSessionId: null,
                createOutcome: "unknown",
                createIntent: expect.objectContaining({
                    clientRecordingId: meta.clientRecordingId,
                }),
            });
            return create.promise;
        });
        const start = startFromPopup();
        await vi.waitFor(() => expect(h.createSession).toHaveBeenCalledOnce());
        const stop = message({ type: "stop-recording" }, extension);
        await new Promise((resolve) => setTimeout(resolve, 0));
        create.resolve({
            id: "server-cancelled",
            encryption: { protocol: 1, key: "key" },
        });
        expect(await start).toMatchObject({ cancelled: true });
        expect(await stop).toEqual({ ok: true });
        expect(h.abortSession).toHaveBeenCalledExactlyOnceWith(
            expect.anything(),
            "server-cancelled",
        );
        expect(
            chrome.runtime.sendMessage.mock.calls.some(
                ([request]) =>
                    request.target === "offscreen" && request.type === "start",
            ),
        ).toBe(false);
        expect(h.metas.size).toBe(0);
    });

    it("cancels the picker while its window is still opening", async () => {
        const opening = Promise.withResolvers();
        chrome.windows.create.mockReturnValueOnce(opening.promise);
        const start = startFromPopup({ forceDesktop: true });
        await vi.waitFor(() =>
            expect(chrome.windows.create).toHaveBeenCalledOnce(),
        );
        expect(await message({ type: "stop-recording" }, extension)).toEqual({
            ok: true,
        });
        opening.resolve({ id: 77 });
        expect(await start).toMatchObject({ cancelled: true });
        expect(chrome.windows.remove).toHaveBeenCalledWith(77);
        expect(h.createSession).not.toHaveBeenCalled();
        expect(h.session.recordingState).toBeUndefined();
        expect(h.metas.size).toBe(0);
    });

    it("cancels an attached session before the tab host receives its Start", async () => {
        h.listChunkIndices.mockResolvedValue([]);
        const stream = Promise.withResolvers();
        chrome.tabCapture.getMediaStreamId.mockImplementationOnce(
            (_input, callback) => stream.promise.then(callback),
        );
        const start = startFromPopup();
        await vi.waitFor(() =>
            expect(chrome.tabCapture.getMediaStreamId).toHaveBeenCalledOnce(),
        );
        chrome.runtime.sendMessage.mockImplementation(async (request) =>
            request.type === "stop"
                ? { ok: false }
                : request.type === "ping"
                  ? { ok: true, captureId: null }
                  : { ok: true },
        );
        expect(await message({ type: "stop-recording" }, extension)).toEqual({
            ok: true,
        });
        stream.resolve("stream-1");
        expect(await start).toMatchObject({ cancelled: true });
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ target: "offscreen", type: "start" }),
        );
        expect(h.abortSession).toHaveBeenCalledExactlyOnceWith(
            expect.anything(),
            "session-1",
        );
        expect(h.metas.size).toBe(0);
    });

    it("retains the first committed chunk when the Stop event reports zero", async () => {
        live();
        expect(
            await message(
                { type: "stop-recording", captureId: "live" },
                extension,
            ),
        ).toEqual({ ok: true });
        h.listeners.message(
            {
                type: "recording-stopped",
                captureId: "live",
                chunkCount: 0,
                stoppedAt: startedAt,
            },
            offscreen,
            () => {},
        );
        await vi.waitFor(() =>
            expect(h.completeSession).toHaveBeenCalledExactlyOnceWith(
                expect.anything(),
                "server-live",
                expect.objectContaining({ chunkCount: 1, endedAt: startedAt }),
            ),
        );
        expect(h.abortSession).not.toHaveBeenCalled();
        expect(h.metas.get("live")).toMatchObject({
            verifiedPrefix: 0,
            chunkCount: 1,
        });
    });

    it("skips an older blocked capture, respects pairing, and keeps the live host while one upload runs", async () => {
        live();
        durable("newer", { startedAt: "2026-10-21T11:11:00.000Z" });
        durable("foreign", {
            startedAt: "2026-10-21T11:08:00.000Z",
            pairing: { ...pairing(), serverOrigin: "https://other.example" },
        });
        durable("other-account", {
            startedAt: "2026-10-21T11:09:00.000Z",
            pairing: pairing("other-account"),
        });
        durable("blocked", { startedAt: "2026-10-21T11:10:00.000Z" });
        const lookup = h.getSession.getMockImplementation();
        h.getSession.mockImplementation(async (auth, id) => {
            if (id === "server-other-account")
                throw Object.assign(new Error("Not found"), { status: 404 });
            if (id === "server-blocked")
                throw Object.assign(new Error("Retry later"), {
                    status: 429,
                    retryAfterSeconds: 60,
                });
            return lookup(auth, id);
        });
        h.listeners.message(
            { type: "chunk-ready", captureId: "live", index: 0 },
            offscreen,
            () => {},
        );
        await vi.waitFor(() =>
            expect(h.uploadChunk.mock.calls.map((call) => call[1])).toEqual([
                "server-newer",
                "server-live",
            ]),
        );
        expect(
            h.getSession.mock.calls.map((call) => call[1]).slice(0, 3),
        ).toEqual(["server-other-account", "server-blocked", "server-newer"]);
        expect(h.metas.get("blocked").nextRetryAt).toBeTruthy();
        expect(h.metas.has("foreign")).toBe(true);
        expect(h.metas.has("other-account")).toBe(true);
        expect(h.session.recordingState).toMatchObject({
            captureId: "live",
            stopped: false,
        });
    });

    it("skips another known account at the same origin without a session lookup", async () => {
        h.local.serverDefaults.accountId = "active-account";
        durable("other", { pairing: pairing("old-key", "other-account") });
        await h.listeners.alarm({ name: "upload-retry" });
        expect(h.getSession).not.toHaveBeenCalled();
        expect(h.uploadChunk).not.toHaveBeenCalled();
        expect(h.metas.has("other")).toBe(true);
    });

    it("accepts a replacement credential for the same server session only after the server verifies it", async () => {
        h.local.serverDefaults.accountId = "opaque-account";
        durable("rebound", { pairing: pairing("old-key", "opaque-account") });
        await h.listeners.alarm({ name: "upload-retry" });
        await vi.waitFor(() => expect(h.uploadChunk).toHaveBeenCalled());
        expect(h.getSession).toHaveBeenCalledWith(
            expect.anything(),
            "server-rebound",
        );
        expect(h.metas.get("rebound").pairing).toEqual({
            serverOrigin: serverUrl,
            accountId: "opaque-account",
            connectionId: "1.2.3",
        });
    });
});

describe("durable Complete", () => {
    it.each([
        "timeout",
        "502",
        "foreign-response",
    ])("replays the exact persisted body after %s", async (failure) => {
        live();
        h.local.serverDefaults.agendas = true;
        Object.assign(h.session.recordingState, {
            stopped: true,
            chunkCount: 2,
            uploaded: [0],
            truncatedAtChunk: 1,
            stopReason: "user",
        });
        const endedAt = "2026-10-21T12:12:13.000Z";
        const body = {
            chunkCount: 2,
            truncatedAtChunk: 1,
            endedAt,
            stopReason: "user",
            agendaId: "agenda-one",
            folderId: "folder-one",
        };
        durable("live", {
            stoppedAt: endedAt,
            chunkCount: 2,
            truncatedAtChunk: 1,
            agendaId: "agenda-one",
            agendaExplicit: true,
            folderId: "folder-one",
            recordingFolderOverride: true,
        });
        h.completeSession.mockImplementationOnce(
            async (_auth, _id, request) => {
                expect(request).toEqual(body);
                expect(h.metas.get("live").completeIntent).toEqual(body);
                throw Object.assign(
                    new Error(failure),
                    failure === "502"
                        ? { kind: "server", status: 502 }
                        : { kind: "unreachable", detail: { kind: failure } },
                );
            },
        );
        await message({ type: "check-finalization" }, extension);
        expect(h.metas.get("live").completeIntent).toEqual(body);
        Object.assign(h.metas.get("live"), {
            agendaId: "agenda-two",
            folderId: "folder-two",
        });
        h.local.serverDefaults.agendas = false;
        expect(
            await message(
                { type: "retry-upload", captureId: "live" },
                extension,
            ),
        ).toEqual({ ok: true });
        expect(
            h.completeSession.mock.calls.map(([, , request]) => request),
        ).toEqual([body, body]);
        expect(h.metas.get("live").completeIntent).toBeNull();
    });

    it("replays the saved intent on startup when the prior Complete advanced the server", async () => {
        const body = {
            chunkCount: 1,
            endedAt: startedAt,
            stopReason: "user",
            agendaId: null,
        };
        durable("detached", { completeIntent: body });
        h.getSession.mockResolvedValue({
            id: "server-detached",
            status: "completing",
            job_id: "job-one",
        });
        h.completeSession.mockResolvedValue({
            id: "server-detached",
            status: "completing",
            job_id: "job-one",
        });
        h.listeners.startup();
        await vi.waitFor(() =>
            expect(h.metas.get("detached").completeIntent).toBeNull(),
        );
        expect(h.completeSession).toHaveBeenCalledExactlyOnceWith(
            expect.anything(),
            "server-detached",
            body,
        );
        expect(h.uploadChunk).not.toHaveBeenCalled();
    });

    it("reuploads the verified prefix to the replacement before replaying partial Complete", async () => {
        const body = {
            chunkCount: 4,
            truncatedAtChunk: 2,
            endedAt: startedAt,
            stopReason: "stream-ended",
        };
        durable("detached", {
            chunkCount: 4,
            truncatedAtChunk: 2,
            verifiedPrefix: 1,
            completeIntent: body,
        });
        h.listChunkIndices.mockResolvedValue([0, 1, 3]);
        h.getSession.mockResolvedValueOnce({
            id: "server-detached",
            status: "aborted",
        });
        h.recoverSession.mockResolvedValueOnce({
            id: "replacement",
            status: "open",
            received_chunks: [0],
        });
        const upload = Promise.withResolvers();
        h.uploadChunk.mockReturnValueOnce(upload.promise);
        const retry = message(
            { type: "retry-buffer", bufferId: "detached" },
            options,
        );
        try {
            await vi.waitFor(() =>
                expect(h.uploadChunk).toHaveBeenCalledExactlyOnceWith(
                    expect.anything(),
                    "replacement",
                    1,
                    expect.any(Blob),
                    undefined,
                ),
            );
            expect(h.completeSession).not.toHaveBeenCalled();
        } finally {
            upload.resolve();
        }
        expect(await retry).toEqual({ ok: true });
        expect(h.completeSession).toHaveBeenCalledExactlyOnceWith(
            expect.anything(),
            "replacement",
            body,
        );
        expect(h.metas.get("detached").completeIntent).toBeNull();
    });

    it("refreshes stale receipts and fills the gap before retrying partial Complete", async () => {
        live();
        Object.assign(h.session.recordingState, {
            stopped: true,
            chunkCount: 3,
            truncatedAtChunk: 2,
            uploaded: [0, 1],
            stopReason: "user",
        });
        durable("live", {
            chunkCount: 3,
            truncatedAtChunk: 2,
            verifiedPrefix: 1,
        });
        h.listChunkIndices.mockResolvedValue([0, 1]);
        h.getSession.mockResolvedValue({
            id: "server-live",
            status: "open",
            received_chunks: [0],
        });
        h.completeSession.mockRejectedValueOnce(
            Object.assign(new Error("Missing chunk"), {
                status: 422,
                field: "chunkCount",
            }),
        );
        await message({ type: "check-finalization" }, extension);
        const original = h.metas.get("live").completeIntent;
        expect(original).toMatchObject({ chunkCount: 3, truncatedAtChunk: 2 });
        expect(h.session.recordingState.uploaded).toEqual([0]);
        h.completeSession.mockImplementationOnce(async () => {
            expect(h.uploadChunk).toHaveBeenCalledExactlyOnceWith(
                expect.anything(),
                "server-live",
                1,
                expect.any(Blob),
                undefined,
            );
            return { job_id: "job-one" };
        });
        expect(
            await message(
                { type: "retry-upload", captureId: "live" },
                extension,
            ),
        ).toEqual({ ok: true });
        expect(h.completeSession.mock.calls.map(([, , body]) => body)).toEqual([
            original,
            original,
        ]);
        expect(h.metas.get("live").completeIntent).toBeNull();
    });
});
