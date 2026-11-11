import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../../../extensions/recorder/lib/api.js";
import { ALARMS, STATE } from "../../../extensions/recorder/lib/constants.js";
import { canPumpUploads } from "../../../extensions/recorder/lib/upload-state.js";

const source = readFileSync("extensions/recorder/service-worker.js", "utf8");
const optionsSender = {
    id: "test",
    url: "chrome-extension://test/options/options.html",
};
const stopped = (patch = {}) => ({
    state: "recording",
    sessionId: "session-one",
    bufferId: "buffer-one",
    stopped: true,
    blocked: false,
    uploaded: [0, 1],
    chunkCount: 2,
    stopReason: "user",
    captureMode: "tab",
    ...patch,
});
const drain = async () => {
    for (let i = 0; i < 150; i++) await Promise.resolve();
};
function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function worker(initial = { state: "idle" }, overrides = {}) {
    const listeners = {};
    const values = { recordingState: initial };
    const metas = new Map([
        [
            "buffer-one",
            {
                serverUrl: "https://recorder.example",
                serverSessionId: "session-one",
                folderId: "folder-one",
                folderScope: "org",
                agendaId: "agenda-one",
                agendaExplicit: true,
            },
        ],
    ]);
    const event = (name) => ({
        addListener: (fn) => {
            listeners[name] = fn;
        },
    });
    const noop = vi.fn(async () => {});
    const chrome = {
        storage: {
            local: { setAccessLevel: noop },
            session: {
                get: vi.fn(async (key) =>
                    key
                        ? { [key]: structuredClone(values[key]) }
                        : structuredClone(values),
                ),
                set: vi.fn(async (patch) =>
                    Object.assign(values, structuredClone(patch)),
                ),
                remove: vi.fn(async (key) => {
                    delete values[key];
                }),
            },
            onChanged: event("storage"),
        },
        runtime: {
            id: "test",
            getURL: (path) => `chrome-extension://test/${path}`,
            getContexts: vi.fn(async () => []),
            getManifest: () => ({ version: "0.9.7" }),
            sendMessage: noop,
            onMessage: event("message"),
            onMessageExternal: event("external"),
            onStartup: event("startup"),
            onInstalled: event("installed"),
        },
        action: {
            onClicked: event("action"),
            setTitle: noop,
            setBadgeText: noop,
            setBadgeBackgroundColor: noop,
        },
        commands: { onCommand: event("command") },
        alarms: {
            onAlarm: event("alarm"),
            create: vi.fn(async () => {}),
            get: noop,
        },
        permissions: { onAdded: event("added"), onRemoved: event("removed") },
        notifications: {
            onClicked: event("notice"),
            onButtonClicked: event("noticeButton"),
            create: noop,
        },
        tabs: {
            onUpdated: event("updated"),
            onRemoved: event("removedTab"),
            query: vi.fn(async () => []),
            create: noop,
        },
        windows: { onRemoved: event("removedWindow"), update: noop },
    };
    const deps = {};
    for (const match of source.matchAll(
        /import\s*\{([^}]+)\}\s*from\s*"[^"]+";/g,
    )) {
        for (const name of match[1]
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean)) {
            deps[name] = vi.fn(async () => {});
        }
    }
    Object.assign(deps, {
        STATE,
        ALARMS,
        MESSAGES: {},
        canPumpUploads,
        t: (key) => key,
        getSettings: vi.fn(async () => ({
            dataUseAcknowledgedAt: "yes",
            serverUrl: "https://recorder.example",
            hasApiKey: true,
        })),
        readToken: vi.fn(async () => "op_test"),
        agendaCompletion: () => ({}),
        supportsAgendas: () => false,
        readLocalMeta: vi.fn(async (id) => metas.get(id)),
        createLocalSession: vi.fn(async (id, meta) => metas.set(id, meta)),
        deleteLocalSession: vi.fn(async (id) => metas.delete(id)),
        listLocalSessions: vi.fn(async () => [...metas.keys()]),
        listChunkIndices: vi.fn(async () => [0, 1]),
        readChunk: vi.fn(async () => new Blob(["encrypted"])),
        sha256Hex: vi.fn(async () => "0".repeat(64)),
        uploadChunk: vi.fn(async () => {}),
        completeSession: vi.fn(async () => ({ job_id: "job-one" })),
        getSession: vi.fn(async () => ({
            id: "session-one",
            status: "completing",
            job_id: "job-one",
        })),
        recoverSession: vi.fn(async () => ({
            id: "session-new",
            status: "open",
            received_chunks: [],
        })),
        ...overrides,
    });
    const ctx = vm.createContext({
        ...deps,
        chrome,
        URL,
        Date,
        console,
        setTimeout,
        clearTimeout,
    });
    vm.runInContext(
        source.replace(/import\s*\{[^}]+\}\s*from\s*"[^"]+";/g, ""),
        ctx,
    );
    const message = (input, sender = optionsSender) =>
        new Promise((resolve) => listeners.message(input, sender, resolve));
    return { ctx, chrome, listeners, values, metas, deps, message };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("#383 stalled completion", () => {
    describe.each([
        "module load",
        "poll",
        "startup",
        "buffer recovery",
        "failed startup lookup",
        "failed alarm lookup",
    ])("upload retry alarm on %s", (trigger) => {
        it.each([
            "missing",
            "sooner",
            "deadline",
            "later",
        ])("keeps alarms due by the requested deadline and replaces later ones (alarm=%s)", async (timing) => {
            vi.useFakeTimers();
            const delayInMinutes = trigger.startsWith("failed") ? 1 : 0.5;
            const finalizing = stopped({
                state: "finalizing",
                jobId: "job-one",
            });
            const h = worker(
                trigger === "module load" ? finalizing : undefined,
            );
            const alarm =
                timing === "missing"
                    ? undefined
                    : {
                          name: ALARMS.uploadRetry,
                          scheduledTime:
                              Date.now() +
                              (timing === "later"
                                  ? 3600000
                                  : timing === "deadline"
                                    ? delayInMinutes * 60000
                                    : 10000),
                      };
            h.chrome.alarms.get = vi.fn(async (name) =>
                name === ALARMS.uploadRetry ? alarm : undefined,
            );
            await drain();
            if (trigger !== "module load") {
                if (trigger !== "buffer recovery")
                    h.values.recordingState = finalizing;
                if (trigger.startsWith("failed")) {
                    h.deps.getSession.mockRejectedValue(
                        new Error("Network unavailable"),
                    );
                }
                if (trigger === "poll") {
                    expect(
                        await h.message({ type: "check-finalization" }),
                    ).toEqual({ ok: true });
                } else if (trigger === "failed alarm lookup") {
                    await h.listeners.alarm({ name: ALARMS.uploadRetry });
                } else {
                    await h.ctx.reconcileOnStartup();
                }
            }
            expect(h.chrome.alarms.get).toHaveBeenCalledWith(
                ALARMS.uploadRetry,
            );
            const retries = h.chrome.alarms.create.mock.calls.filter(
                ([name]) => name === ALARMS.uploadRetry,
            );
            expect(retries).toEqual(
                timing === "sooner" || timing === "deadline"
                    ? []
                    : [
                          [
                              ALARMS.uploadRetry,
                              {
                                  delayInMinutes,
                              },
                          ],
                      ],
            );
        });
    });

    it("keeps a stop request arriving after the last pump state read", async () => {
        const lastRead = deferred();
        const h = worker(stopped({ stopped: false }));
        await drain();
        h.deps.listChunkIndices.mockImplementationOnce(() => lastRead.promise);
        const pump = h.ctx.pumpUploads();
        await drain();
        expect(h.deps.listChunkIndices).toHaveBeenCalledOnce();
        h.listeners.message(
            {
                type: "recording-stopped",
                sessionId: "session-one",
                chunkCount: 2,
            },
            {},
            () => {},
        );
        await drain();
        expect(h.values.recordingState.stopped).toBe(true);
        lastRead.resolve([]);
        await pump;
        expect(h.deps.completeSession).toHaveBeenCalledOnce();
    });

    it("publishes the desktop's final chunk count with the stopped flag", async () => {
        const stored = deferred();
        const h = worker(
            stopped({ stopped: false, chunkCount: 0, captureMode: "desktop" }),
        );
        await drain();
        h.deps.listChunkIndices.mockImplementationOnce(() => stored.promise);
        const stop = h.ctx.handleRecordingStopped({
            sessionId: "session-one",
            chunkCount: 2,
        });
        await drain();
        expect(h.values.recordingState).toMatchObject({
            stopped: true,
            chunkCount: 2,
        });
        await h.message({ type: "check-finalization" });
        expect(h.deps.completeSession).toHaveBeenCalledExactlyOnceWith(
            expect.anything(),
            "session-one",
            expect.objectContaining({ chunkCount: 2 }),
        );
        stored.resolve([0, 1]);
        await stop;
        expect(h.deps.completeSession).toHaveBeenCalledOnce();
    });

    it.each([
        "recording",
        "finalizing",
    ])("self-heals %s without a job on every module load", async (state) => {
        const h = worker(stopped({ state, jobId: null }));
        await drain();
        expect(h.deps.completeSession).toHaveBeenCalledOnce();
        expect(h.values.recordingState).toMatchObject({
            state: "finalizing",
            jobId: "job-one",
        });
    });

    it.each([
        "recording",
        "finalizing",
    ])("self-heals %s from popup/picker polling", async (state) => {
        const h = worker();
        await drain();
        h.values.recordingState = stopped({ state, jobId: null });
        expect(await h.message({ type: "check-finalization" })).toEqual({
            ok: true,
        });
        expect(h.deps.completeSession).toHaveBeenCalledOnce();
    });

    it.each([
        { stopped: false },
        { blocked: true },
        { state: "awaiting-picker", captureMode: "desktop" },
    ])("leaves a live, blocked or picker state alone: %j", async (patch) => {
        const h = worker(stopped(patch));
        await drain();
        await h.message({ type: "check-finalization" });
        expect(h.deps.completeSession).not.toHaveBeenCalled();
        expect(h.deps.uploadChunk).not.toHaveBeenCalled();
    });

    it("serializes complete calls while several healing and prefix paths run", async () => {
        const completion = deferred();
        const completeSession = vi.fn(() => completion.promise);
        const h = worker(stopped(), { completeSession });
        await drain();
        const checks = [
            h.message({ type: "check-finalization" }),
            h.ctx.finalize(),
            h.ctx.pumpUploads(),
        ];
        await drain();
        expect(completeSession).toHaveBeenCalledOnce();
        completion.resolve({ job_id: "job-one" });
        await Promise.all(checks);
        expect(completeSession).toHaveBeenCalledOnce();
    });

    it("startup pumps a stopped tab capture without an offscreen document", async () => {
        const h = worker();
        await drain();
        h.values.recordingState = stopped();
        await h.ctx.reconcileOnStartup();
        expect(h.deps.completeSession).toHaveBeenCalledOnce();
    });

    it("startup retries completion interrupted before the job id was saved", async () => {
        const h = worker();
        await drain();
        h.values.recordingState = stopped({ state: "finalizing", jobId: null });
        await h.ctx.reconcileOnStartup();
        expect(h.deps.completeSession).toHaveBeenCalledOnce();
    });
});

describe("#383 recovery and buffer ownership", () => {
    it("keeps alarm and pump requests out of a playable-prefix transition", async () => {
        const unblocked = deferred();
        const completion = deferred();
        const h = worker(
            stopped({
                state: "error",
                blocked: true,
                chunkCount: 3,
                recoverablePrefix: 2,
            }),
            { completeSession: vi.fn(() => completion.promise) },
        );
        await drain();
        const write = h.chrome.storage.session.set.getMockImplementation();
        h.chrome.storage.session.set.mockImplementation(async (patch) => {
            await write(patch);
            if (
                patch.recordingState?.state === "error" &&
                !patch.recordingState.blocked
            )
                await unblocked.promise;
        });
        const save = h.message({ type: "save-prefix", chunkCount: 2 });
        await drain();
        expect(h.values.recordingState.blocked).toBe(false);
        const alarm = h.listeners.alarm({ name: ALARMS.uploadRetry });
        const pump = h.ctx.pumpUploads();
        await drain();
        expect(h.deps.listChunkIndices).not.toHaveBeenCalled();
        expect(h.deps.completeSession).not.toHaveBeenCalled();
        unblocked.resolve();
        await drain();
        expect(h.values.recordingState).toMatchObject({
            state: "finalizing",
            blocked: false,
            recoverablePrefix: 2,
        });
        await h.listeners.alarm({ name: ALARMS.uploadRetry });
        await h.ctx.pumpUploads();
        expect(h.deps.listChunkIndices).not.toHaveBeenCalled();
        completion.resolve({ job_id: "job-one" });
        expect(await save).toEqual({ ok: true });
        await Promise.all([alarm, pump]);
        expect(h.deps.completeSession).toHaveBeenCalledExactlyOnceWith(
            expect.anything(),
            "session-one",
            expect.objectContaining({ chunkCount: 3, truncatedAtChunk: 2 }),
        );
        expect(h.deps.listChunkIndices).not.toHaveBeenCalled();
        expect(h.values.recordingState).toMatchObject({
            state: "finalizing",
            jobId: "job-one",
            blocked: false,
            recoverablePrefix: 2,
        });
        for (const [patch] of h.chrome.storage.session.set.mock.calls) {
            expect(patch.recordingState).toMatchObject({
                blocked: false,
                recoverablePrefix: 2,
            });
        }
    });

    it.each([
        0,
        1,
        3,
        2.5,
        "2",
    ])("rejects an unverified playable-prefix count %s", async (chunkCount) => {
        const initial = stopped({
            state: "error",
            blocked: true,
            chunkCount: 3,
            recoverablePrefix: 2,
        });
        const h = worker(initial);
        await drain();
        expect(await h.message({ type: "save-prefix", chunkCount })).toEqual({
            ok: false,
            error: "No verified playable prefix is available",
        });
        expect(h.values.recordingState).toEqual(initial);
        expect(h.deps.completeSession).not.toHaveBeenCalled();
    });

    it.each([
        "recording",
        "finalizing",
    ])("uploads pending chunks on %s wake and polling", async (state) => {
        const h = worker(stopped({ state, jobId: null, uploaded: [1] }));
        await drain();
        expect(h.deps.uploadChunk.mock.calls.map((call) => call[2])).toEqual([
            0,
        ]);
        expect(h.deps.completeSession).toHaveBeenCalledOnce();
        h.values.recordingState = stopped({ state, jobId: null, uploaded: [] });
        h.deps.uploadChunk.mockClear();
        await h.message({ type: "check-finalization" });
        expect(h.deps.uploadChunk.mock.calls.map((call) => call[2])).toEqual([
            0, 1,
        ]);
        expect(h.deps.completeSession).toHaveBeenCalledTimes(2);
    });

    it("re-arms pending upload backoff on wake without sending early", async () => {
        const h = worker();
        await drain();
        const when = Date.now() + 60000;
        h.metas.get("buffer-one").nextRetryAt = new Date(when).toISOString();
        h.values.recordingState = stopped({ uploaded: [] });
        await h.ctx.healStoppedUpload();
        expect(h.chrome.alarms.create).toHaveBeenCalledWith(
            ALARMS.uploadRetry,
            { when },
        );
        expect(h.deps.uploadChunk).not.toHaveBeenCalled();
    });

    it("recovers a saved completion job on wake and dedupes concurrent polling", async () => {
        const status = deferred();
        const h = worker(stopped({ state: "finalizing", jobId: "job-one" }), {
            getSession: vi.fn(() => status.promise),
        });
        await drain();
        expect(
            h.deps.getSession.mock.calls.length +
                h.chrome.alarms.create.mock.calls.length,
        ).toBeGreaterThan(0);
        const first = h.message({ type: "check-finalization" });
        const second = h.message({ type: "check-finalization" });
        await drain();
        expect(h.deps.getSession).toHaveBeenCalledOnce();
        status.resolve({ status: "completing", job_id: "job-one" });
        await Promise.all([first, second]);
        expect(h.deps.completeSession).not.toHaveBeenCalled();
        expect(h.chrome.alarms.create).toHaveBeenCalledWith(
            ALARMS.uploadRetry,
            expect.anything(),
        );
    });

    it.each([
        false,
        true,
    ])("discard preserves a newer capture after a stalled lookup (legacy buffer=%s)", async (legacy) => {
        const h = worker(
            stopped({
                state: "error",
                blocked: true,
                ...(legacy ? { bufferId: null, sessionId: "buffer-one" } : {}),
            }),
        );
        await drain();
        const status = deferred();
        h.deps.getSession.mockImplementationOnce(() => status.promise);
        const discard = h.message({
            type: "discard-buffer",
            bufferId: "buffer-one",
        });
        await drain();
        await expect(h.ctx.startRecording({})).rejects.toThrow(
            "alreadyInProgress",
        );
        const newer = stopped({
            sessionId: "session-two",
            bufferId: "buffer-two",
            stopped: false,
        });
        h.values.recordingState = newer;
        status.resolve({ status: "open" });
        expect(await discard).toEqual({ ok: true });
        expect(h.values.recordingState).toEqual(newer);
        expect(h.deps.deleteLocalSession).toHaveBeenCalledExactlyOnceWith(
            "buffer-one",
        );
    });

    it("discard resets its current legacy buffer after deletion", async () => {
        const h = worker(
            stopped({
                state: "error",
                blocked: true,
                bufferId: null,
                sessionId: "buffer-one",
            }),
        );
        await drain();
        h.deps.getSession.mockResolvedValue({ status: "open" });
        await h.message({ type: "discard-buffer", bufferId: "buffer-one" });
        expect(h.values.recordingState).toBeUndefined();
    });

    it.each([
        "upload",
        "finalize",
    ])("discard waits for an in-flight %s before looking up or deleting its buffer", async (operation) => {
        const pending = deferred();
        const h = worker(
            stopped({ uploaded: operation === "upload" ? [] : [0, 1] }),
            {
                ...(operation === "upload"
                    ? { uploadChunk: vi.fn(() => pending.promise) }
                    : { completeSession: vi.fn(() => pending.promise) }),
            },
        );
        await drain();
        const discard = h.message({
            type: "discard-buffer",
            bufferId: "buffer-one",
        });
        await drain();
        expect(h.deps.getSession).not.toHaveBeenCalled();
        expect(h.deps.deleteLocalSession).not.toHaveBeenCalled();
        h.deps.getSession.mockResolvedValue({ status: "open" });
        pending.resolve({ job_id: "job-one" });
        await discard;
        expect(h.deps.deleteLocalSession).toHaveBeenCalledWith("buffer-one");
    });

    it("keeps alarm pump requests behind a retry transition and sends the new buffer's missing chunk", async () => {
        const h = worker(stopped({ state: "error", uploaded: [] }));
        await drain();
        h.metas.set("buffer-two", {
            ...h.metas.get("buffer-one"),
            serverSessionId: "session-two",
        });
        const status = deferred();
        h.deps.getSession.mockImplementationOnce(() => status.promise);
        const retry = h.message({
            type: "retry-buffer",
            bufferId: "buffer-two",
        });
        await drain();
        const alarm = h.listeners.alarm({ name: ALARMS.uploadRetry });
        await drain();
        expect(h.deps.uploadChunk).not.toHaveBeenCalled();
        status.resolve({
            id: "session-two",
            status: "open",
            received_chunks: [],
        });
        await Promise.all([retry, alarm]);
        expect(
            h.deps.uploadChunk.mock.calls.map((call) => [call[1], call[2]]),
        ).toEqual([
            ["session-two", 0],
            ["session-two", 1],
        ]);
    });

    it("rechecks competing work after a retry's server lookup", async () => {
        const h = worker();
        await drain();
        const status = deferred();
        h.deps.getSession.mockImplementationOnce(() => status.promise);
        const retry = h.message({
            type: "retry-buffer",
            bufferId: "buffer-one",
        });
        await drain();
        const newer = stopped({
            sessionId: "session-two",
            bufferId: "buffer-two",
        });
        h.values.recordingState = newer;
        status.resolve({
            id: "session-one",
            status: "open",
            received_chunks: [],
        });
        expect(await retry).toEqual({ ok: false, error: "retryBufferBusy" });
        expect(h.values.recordingState).toEqual(newer);
    });

    it("rechecks competing work after reading stored chunk indices", async () => {
        const h = worker();
        await drain();
        h.deps.getSession.mockResolvedValueOnce({
            id: "session-one",
            status: "open",
            received_chunks: [],
        });
        const chunks = deferred();
        h.deps.listChunkIndices.mockImplementationOnce(() => chunks.promise);
        const retry = h.message({
            type: "retry-buffer",
            bufferId: "buffer-one",
        });
        await drain();
        const newer = stopped({
            sessionId: "session-two",
            bufferId: "buffer-two",
        });
        h.values.recordingState = newer;
        chunks.resolve([0, 1]);
        expect(await retry).toEqual({ ok: false, error: "retryBufferBusy" });
        expect(h.values.recordingState).toEqual(newer);
    });

    it("queues retries after a failed transition and preserves a pump request during discard", async () => {
        const h = worker(stopped({ state: "error", uploaded: [] }));
        await drain();
        h.metas.set("buffer-two", {
            ...h.metas.get("buffer-one"),
            serverSessionId: "session-two",
        });
        const status = deferred();
        h.deps.getSession.mockImplementationOnce(() => status.promise);
        const discard = h.message({
            type: "discard-buffer",
            bufferId: "buffer-two",
        });
        await drain();
        const retry = h.message({
            type: "retry-buffer",
            bufferId: "buffer-one",
        });
        const queuedRetry = h.message({
            type: "retry-buffer",
            bufferId: "buffer-one",
        });
        const alarm = h.listeners.alarm({ name: ALARMS.uploadRetry });
        await drain();
        expect(h.deps.getSession).toHaveBeenCalledOnce();
        expect(h.deps.uploadChunk).not.toHaveBeenCalled();
        status.resolve({ status: "completing" });
        expect(await discard).toMatchObject({ ok: false });
        h.deps.getSession.mockResolvedValue({
            id: "session-one",
            status: "open",
            received_chunks: [],
        });
        expect(await retry).toEqual({ ok: true });
        expect(await queuedRetry).toEqual({ ok: true });
        await alarm;
        expect(h.deps.uploadChunk.mock.calls.map((call) => call[2])).toEqual([
            0, 1,
        ]);
        expect(h.deps.completeSession).toHaveBeenCalledOnce();
    });

    it.each([
        "sessionId",
        "bufferId",
    ])("ignores upload responses when %s ownership changes", async (field) => {
        const upload = deferred();
        const h = worker(stopped({ stopped: false, uploaded: [] }), {
            uploadChunk: vi.fn(() => upload.promise),
        });
        await drain();
        const pump = h.ctx.pumpUploads();
        await drain();
        const newer = stopped({
            [field]: "different",
            uploaded: [],
            stopped: false,
        });
        h.values.recordingState = newer;
        upload.resolve();
        await pump;
        expect(h.values.recordingState).toEqual(newer);
        expect(h.deps.uploadChunk).toHaveBeenCalledOnce();
    });

    it.each([
        "sessionId",
        "bufferId",
    ])("ignores completion responses when %s ownership changes", async (field) => {
        const completion = deferred();
        const h = worker(stopped(), {
            completeSession: vi.fn(() => completion.promise),
        });
        await drain();
        const pump = h.ctx.pumpUploads();
        const newer = stopped({ [field]: "different", stopped: false });
        h.values.recordingState = newer;
        completion.resolve({ job_id: "stale-job" });
        await pump;
        expect(h.values.recordingState).toEqual(newer);
        expect(h.deps.getSession).not.toHaveBeenCalled();
    });
});

function httpError(status, code) {
    return Object.assign(new Error("server error"), { status, code });
}

describe("#383 completion retries", () => {
    it.each([
        [503, "ACCESS_UNVERIFIABLE", 0],
        [500, undefined, 0],
        [502, undefined, 0],
        [504, undefined, 0],
        [429, undefined, 60],
        [undefined, undefined, 0],
    ])("retries transient completion failures with backoff (%s/%s, Retry-After=%s)", async (status, code, retryAfterSeconds) => {
        vi.useFakeTimers();
        const error = Object.assign(httpError(status, code), {
            retryAfterSeconds,
        });
        const completeSession = vi
            .fn()
            .mockRejectedValueOnce(error)
            .mockRejectedValueOnce(error)
            .mockResolvedValue({ job_id: "job-one" });
        const h = worker(undefined, { completeSession });
        await drain();
        h.values.recordingState = stopped();
        await h.ctx.pumpUploads();
        for (let attempt = 1; attempt <= 2; attempt++) {
            expect(h.values.recordingState).toMatchObject({
                state: "error",
                stopped: true,
                blocked: false,
                error:
                    code === "ACCESS_UNVERIFIABLE"
                        ? "accessUnverifiable"
                        : "server error",
            });
            const meta = h.metas.get("buffer-one");
            const when = Date.parse(meta.nextRetryAt);
            const backoff = 5000 * 2 ** (attempt - 1);
            expect(meta.retryAttempt).toBe(attempt);
            expect(when - Date.now()).toBeGreaterThanOrEqual(
                Math.max(retryAfterSeconds * 1000, backoff * 0.75),
            );
            expect(when - Date.now()).toBeLessThanOrEqual(
                Math.max(retryAfterSeconds * 1000, backoff * 1.25),
            );
            expect(h.chrome.alarms.create).toHaveBeenCalledWith(
                ALARMS.uploadRetry,
                { when },
            );
            expect(h.deps.deleteLocalSession).not.toHaveBeenCalled();
            await h.listeners.alarm({ name: ALARMS.uploadRetry });
            expect(completeSession).toHaveBeenCalledTimes(attempt);
            await vi.advanceTimersByTimeAsync(when - Date.now());
            await h.listeners.alarm({ name: ALARMS.uploadRetry });
            expect(completeSession).toHaveBeenCalledTimes(attempt + 1);
        }
        expect(h.values.recordingState).toMatchObject({
            state: "finalizing",
            jobId: "job-one",
        });
        h.deps.getSession.mockResolvedValue({
            status: "completed",
            recording_id: "recording-one",
        });
        const alarm = h.listeners.alarm({ name: ALARMS.uploadRetry });
        await drain();
        expect(h.values.recordingState.state).toBe("completed");
        expect(h.deps.deleteLocalSession).toHaveBeenCalledExactlyOnceWith(
            "buffer-one",
        );
        expect(h.deps.uploadChunk).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(4000);
        await alarm;
    });

    it.each([
        400, 401, 403, 404, 409, 422,
    ])("blocks permanent completion failure %s without scheduling a retry", async (status) => {
        const h = worker(undefined, {
            completeSession: vi.fn().mockRejectedValue(httpError(status)),
        });
        await drain();
        h.values.recordingState = stopped();
        await h.ctx.pumpUploads();
        expect(h.values.recordingState).toMatchObject({
            state: "error",
            stopped: true,
            blocked: true,
        });
        expect(h.chrome.alarms.create).not.toHaveBeenCalled();
        expect(h.metas.get("buffer-one")).not.toHaveProperty("nextRetryAt");
        await h.listeners.alarm({ name: ALARMS.uploadRetry });
        expect(h.deps.completeSession).toHaveBeenCalledOnce();
        expect(h.deps.deleteLocalSession).not.toHaveBeenCalled();
    });

    it.each([
        "sessionId",
        "bufferId",
    ])("ignores a transient completion failure after %s ownership changes", async (field) => {
        const completion = deferred();
        const h = worker(undefined, {
            completeSession: vi.fn(() =>
                completion.promise.then(() => {
                    throw httpError(503, "ACCESS_UNVERIFIABLE");
                }),
            ),
        });
        await drain();
        h.values.recordingState = stopped();
        const pump = h.ctx.pumpUploads();
        await drain();
        expect(h.deps.completeSession).toHaveBeenCalledOnce();
        const newer = stopped({ [field]: "different", stopped: false });
        h.values.recordingState = newer;
        completion.resolve();
        await pump;
        expect(h.values.recordingState).toEqual(newer);
        expect(h.chrome.alarms.create).not.toHaveBeenCalled();
        expect(h.metas.get("buffer-one")).not.toHaveProperty("nextRetryAt");
    });
});

describe("#383 retry-buffer", () => {
    it("resumes an open buffer using server receipt indices and retained folder/agenda metadata", async () => {
        const h = worker();
        await drain();
        h.metas.get("buffer-one").nextRetryAt = new Date(
            Date.now() + 60000,
        ).toISOString();
        h.deps.getSession.mockResolvedValueOnce({
            id: "session-one",
            status: "open",
            received_chunks: [0],
        });
        expect(
            await h.message({ type: "retry-buffer", bufferId: "buffer-one" }),
        ).toEqual({ ok: true });
        expect(h.deps.uploadChunk).toHaveBeenCalledExactlyOnceWith(
            expect.anything(),
            "session-one",
            1,
            expect.any(Blob),
            expect.any(String),
        );
        expect(h.deps.completeSession).toHaveBeenCalledOnce();
        expect(h.values.recordingState).toMatchObject({
            folderId: "folder-one",
            folderScope: "org",
            agendaId: "agenda-one",
            stopped: true,
        });
        expect(h.metas.get("buffer-one")).toMatchObject({
            retryAttempt: 0,
            nextRetryAt: null,
        });
    });

    it("uses the same resume helper at startup", async () => {
        const h = worker();
        await drain();
        h.deps.getSession.mockResolvedValueOnce({
            id: "session-one",
            status: "open",
            received_chunks: [0],
        });
        await h.ctx.reconcileOnStartup();
        expect(h.deps.uploadChunk.mock.calls.map((call) => call[2])).toEqual([
            1,
        ]);
        expect(h.values.recordingState).toMatchObject({
            folderId: "folder-one",
            agendaId: "agenda-one",
        });
    });

    it("reconciles an already completed recording and deletes only its buffer", async () => {
        vi.useFakeTimers();
        const h = worker();
        await drain();
        h.deps.getSession.mockResolvedValue({
            id: "session-one",
            status: "completed",
            recording_id: "recording-one",
        });
        const retry = h.message({
            type: "retry-buffer",
            bufferId: "buffer-one",
        });
        await drain();
        expect(h.deps.deleteLocalSession).toHaveBeenCalledWith("buffer-one");
        expect(h.deps.uploadChunk).not.toHaveBeenCalled();
        expect(h.deps.completeSession).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(4000);
        expect(await retry).toEqual({ ok: true });
    });

    it("reconciles a completing recording with its existing job", async () => {
        const h = worker();
        await drain();
        expect(
            await h.message({ type: "retry-buffer", bufferId: "buffer-one" }),
        ).toEqual({ ok: true });
        expect(h.values.recordingState).toMatchObject({
            state: "finalizing",
            jobId: "job-one",
        });
        expect(h.deps.getSession).toHaveBeenCalledTimes(2);
        expect(h.deps.completeSession).not.toHaveBeenCalled();
    });

    it.each([
        "aborted",
        "failed",
    ])("recovers %s and saves the replacement server session id", async (status) => {
        const h = worker();
        await drain();
        h.deps.getSession.mockResolvedValueOnce({ id: "session-one", status });
        expect(
            await h.message({ type: "retry-buffer", bufferId: "buffer-one" }),
        ).toEqual({ ok: true });
        expect(h.deps.recoverSession).toHaveBeenCalledWith(
            expect.anything(),
            "session-one",
        );
        expect(h.metas.get("buffer-one").serverSessionId).toBe("session-new");
        expect(h.deps.completeSession).toHaveBeenCalledWith(
            expect.anything(),
            "session-new",
            expect.anything(),
        );
    });

    it("retries the current stopped buffer through the existing retry path", async () => {
        const h = worker(stopped({ state: "error", blocked: true }));
        await drain();
        h.deps.getSession.mockResolvedValueOnce({
            id: "session-one",
            status: "open",
            received_chunks: [0, 1],
        });
        expect(
            await h.message({ type: "retry-buffer", bufferId: "buffer-one" }),
        ).toEqual({ ok: true });
        expect(h.deps.completeSession).toHaveBeenCalledOnce();
    });

    it("clears an old error when the current recording is already completing", async () => {
        const h = worker(
            stopped({ state: "error", blocked: true, error: "old failure" }),
        );
        await drain();
        expect(
            await h.message({ type: "retry-buffer", bufferId: "buffer-one" }),
        ).toEqual({ ok: true });
        expect(h.values.recordingState).toMatchObject({
            state: "finalizing",
            error: null,
            jobId: "job-one",
        });
        expect(h.deps.completeSession).not.toHaveBeenCalled();
    });

    it("allows an explicit discard of a stopped current buffer whose key expired", async () => {
        const h = worker(stopped({ uploaded: [0] }));
        await drain();
        h.deps.getSession.mockRejectedValue(httpError(404));
        expect(
            await h.message({ type: "retry-buffer", bufferId: "buffer-one" }),
        ).toEqual({ ok: false, error: "recordingKeyExpired" });
        expect(h.deps.deleteLocalSession).not.toHaveBeenCalled();
        expect(
            await h.message({ type: "discard-buffer", bufferId: "buffer-one" }),
        ).toEqual({ ok: true });
        expect(h.deps.deleteLocalSession).toHaveBeenCalledWith("buffer-one");
    });

    it.each([
        [404, undefined, "recordingKeyExpired"],
        [401, undefined, "keyRejected"],
        [403, "ACCESS_NOT_GRANTED", "accessWithdrawn"],
        [503, "ACCESS_UNVERIFIABLE", "accessUnverifiable"],
    ])("translates server refusal %s/%s without deleting the buffer", async (status, code, error) => {
        const h = worker();
        await drain();
        h.deps.getSession.mockRejectedValueOnce(httpError(status, code));
        expect(
            await h.message({ type: "retry-buffer", bufferId: "buffer-one" }),
        ).toEqual({ ok: false, error });
        expect(h.deps.deleteLocalSession).not.toHaveBeenCalled();
        expect(h.values.recordingState.state).toBe("idle");
    });

    it.each([
        stopped({ stopped: false }),
        { state: "awaiting-picker" },
        stopped({ bufferId: "other-buffer", uploaded: [] }),
        stopped({
            bufferId: "other-buffer",
            state: "finalizing",
            jobId: "job-other",
        }),
    ])("refuses during capture or a different active upload: %j", async (initial) => {
        const h = worker(initial);
        await drain();
        h.deps.getSession.mockClear();
        const result = await h.message({
            type: "retry-buffer",
            bufferId: "buffer-one",
        });
        expect(result).toMatchObject({ ok: false });
        expect(["retryBufferCaptureLive", "retryBufferBusy"]).toContain(
            result.error,
        );
        expect(h.deps.getSession).not.toHaveBeenCalled();
    });

    describe.each([
        "retry-buffer",
        "discard-buffer",
    ])("%s sender validation", (type) => {
        it.each([
            "",
            "#meeting-prompt",
            "?x=1#y",
        ])("accepts the options page with suffix %s", async (suffix) => {
            const h = worker();
            await drain();
            h.deps.getSession.mockResolvedValue({
                status: type === "retry-buffer" ? "completing" : "open",
            });
            expect(
                await h.message(
                    { type, bufferId: "buffer-one" },
                    {
                        ...optionsSender,
                        url: optionsSender.url + suffix,
                    },
                ),
            ).toEqual({ ok: true });
            expect(h.deps.readLocalMeta).toHaveBeenCalledWith("buffer-one");
            if (type === "discard-buffer")
                expect(
                    h.deps.deleteLocalSession,
                ).toHaveBeenCalledExactlyOnceWith("buffer-one");
        });

        it.each([
            { id: "unknown", url: optionsSender.url },
            { id: "test", url: "https://unknown.example/" },
            { id: "test", url: "chrome-extension://test/popup/popup.html" },
            {
                id: "test",
                url: "chrome-extension://other/options/options.html#meeting-prompt",
            },
            { id: "test", url: "https://test/options/options.html?x=1#y" },
            {
                id: "test",
                url: "chrome-extension://test/options/options.html/extra",
            },
            { id: "test", url: "not a URL" },
            {},
        ])("refuses unknown senders before reading the buffer: %j", async (sender) => {
            const h = worker();
            await drain();
            expect(
                await h.message({ type, bufferId: "buffer-one" }, sender),
            ).toEqual({ ok: false, error: "unrecognizedSender" });
            expect(h.deps.readLocalMeta).not.toHaveBeenCalled();
            expect(h.deps.deleteLocalSession).not.toHaveBeenCalled();
        });
    });

    it("queues retries and discard, and refuses a capture until transitions finish", async () => {
        const status = deferred();
        const h = worker();
        await drain();
        h.metas.set("buffer-two", {
            ...h.metas.get("buffer-one"),
            serverSessionId: "session-two",
        });
        h.deps.getSession
            .mockImplementationOnce(() => status.promise)
            .mockResolvedValue({ status: "open" });
        const retry = h.message({
            type: "retry-buffer",
            bufferId: "buffer-one",
        });
        await drain();
        const discard = h.message({
            type: "discard-buffer",
            bufferId: "buffer-two",
        });
        await drain();
        expect(h.deps.getSession).toHaveBeenCalledOnce();
        await expect(h.ctx.startRecording({})).rejects.toThrow(
            "alreadyInProgress",
        );
        status.resolve({
            id: "session-one",
            status: "completing",
            job_id: "job-one",
        });
        await retry;
        await discard;
        expect(h.deps.getSession).toHaveBeenCalledTimes(3);
    });
});

describe("#383 request timeouts", () => {
    function hangRequests() {
        vi.useFakeTimers();
        vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
            const controller = new AbortController();
            setTimeout(
                () =>
                    controller.abort(
                        new DOMException("timed out", "TimeoutError"),
                    ),
                ms,
            );
            return controller.signal;
        });
        return vi.spyOn(globalThis, "fetch").mockImplementation(
            (_url, { signal }) =>
                new Promise((_, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => reject(signal.reason),
                        { once: true },
                    );
                }),
        );
    }

    it("gives chunks 120 seconds, then retries a timed-out upload with backoff", async () => {
        hangRequests();
        const h = worker(stopped({ uploaded: [] }), {
            uploadChunk: api.uploadChunk,
        });
        await drain();
        const pumping = h.ctx.pumpUploads();
        await drain();
        await vi.advanceTimersByTimeAsync(119999);
        expect(h.chrome.alarms.create).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await pumping;
        expect(h.values.recordingState).toMatchObject({
            state: "recording",
            blocked: false,
            uploaded: [],
            uploadNotice: "requestTimedOut",
        });
        const meta = h.metas.get("buffer-one");
        expect(meta.retryAttempt).toBe(1);
        expect(
            Date.parse(meta.nextRetryAt) - Date.now(),
        ).toBeGreaterThanOrEqual(3750);
        expect(h.chrome.alarms.create).toHaveBeenCalledWith(
            ALARMS.uploadRetry,
            { when: Date.parse(meta.nextRetryAt) },
        );
        expect(h.deps.completeSession).not.toHaveBeenCalled();
    });

    it("retries a timed-out completion from the error view with its buffer intact", async () => {
        const fetch = hangRequests();
        const h = worker(stopped(), { completeSession: api.completeSession });
        await drain();
        const check = h.message({ type: "check-finalization" });
        await drain();
        await vi.advanceTimersByTimeAsync(30000);
        await check;
        expect(h.values.recordingState).toMatchObject({
            state: "error",
            stopped: true,
            blocked: false,
            error: "requestTimedOut",
        });
        expect(fetch).toHaveBeenCalledOnce();
        expect(h.deps.deleteLocalSession).not.toHaveBeenCalled();
        const meta = h.metas.get("buffer-one");
        const when = Date.parse(meta.nextRetryAt);
        expect(meta.retryAttempt).toBe(1);
        expect(when - Date.now()).toBeGreaterThanOrEqual(3750);
        expect(when - Date.now()).toBeLessThanOrEqual(6250);
        expect(h.chrome.alarms.create).toHaveBeenCalledWith(
            ALARMS.uploadRetry,
            { when },
        );
        fetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ job_id: "job-one" })),
        );
        h.deps.getSession.mockResolvedValue({
            status: "completed",
            recording_id: "recording-one",
        });
        await vi.advanceTimersByTimeAsync(when - Date.now());
        const alarm = h.listeners.alarm({ name: ALARMS.uploadRetry });
        await drain();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(h.values.recordingState.state).toBe("completed");
        expect(h.deps.deleteLocalSession).toHaveBeenCalledExactlyOnceWith(
            "buffer-one",
        );
        await vi.advanceTimersByTimeAsync(4000);
        await alarm;
    });

    it.each([
        false,
        true,
    ])("keeps a body timeout transient even after response headers (error response=%s)", async (errorResponse) => {
        hangRequests();
        vi.mocked(fetch).mockImplementationOnce(async (_url, { signal }) => ({
            ok: !errorResponse,
            status: errorResponse ? 503 : 200,
            json: () =>
                new Promise((_, reject) =>
                    signal.addEventListener(
                        "abort",
                        () => reject(signal.reason),
                        { once: true },
                    ),
                ),
        }));
        const session = api
            .getSession(
                { serverUrl: "https://recorder.example", apiKey: "op_test" },
                "session-one",
            )
            .catch((error) => error);
        await drain();
        await vi.advanceTimersByTimeAsync(30000);
        const error = await session;
        expect(error.message).toBe("requestTimedOut");
        expect(error).not.toHaveProperty("status");
    });

    it("reports a timed-out manual status lookup in the row", async () => {
        hangRequests();
        const h = worker(undefined, { getSession: api.getSession });
        await drain();
        const retry = h.message({
            type: "retry-buffer",
            bufferId: "buffer-one",
        });
        await drain();
        await vi.advanceTimersByTimeAsync(30000);
        expect(await retry).toEqual({ ok: false, error: "requestTimedOut" });
    });

    function agendaStream() {
        const settings = {
            dataUseAcknowledgedAt: "yes",
            serverUrl: "https://recorder.example",
            hasApiKey: true,
            serverDefaults: { agendaLive: true },
        };
        const context = vm.createContext({
            request: api.request,
            getSettings: async () => settings,
            readToken: async () => "op_test",
            supportsAgendas: () => true,
            t: (key) => key,
            AbortController,
            TextDecoder,
            setTimeout,
            clearTimeout,
        });
        for (const path of ["pairing-request-auth.js", "agenda-live.js"]) {
            vm.runInContext(
                readFileSync(`extensions/recorder/lib/${path}`, "utf8")
                    .replace(/^import .*;$/gm, "")
                    .replaceAll("export ", ""),
                context,
            );
        }
        const invalidate = vi.fn();
        const onConnection = vi.fn();
        const stop = context.subscribeAgenda("agenda-one", {
            invalidate,
            onConnection,
        });
        return { stop, invalidate, onConnection };
    }

    it("keeps a healthy agenda SSE stream past the finite request deadline and still allows cancellation", async () => {
        hangRequests();
        let signal;
        let stream;
        vi.mocked(fetch).mockImplementationOnce(async (_url, init) => {
            signal = init.signal;
            const body = new ReadableStream({
                start(controller) {
                    stream = controller;
                    signal.addEventListener(
                        "abort",
                        () => controller.error(signal.reason),
                        { once: true },
                    );
                    controller.enqueue(
                        new TextEncoder().encode(": connected\n\n"),
                    );
                },
            });
            return new Response(body, {
                headers: { "content-type": "text/event-stream" },
            });
        });
        const h = agendaStream();
        await drain();
        expect(h.onConnection).toHaveBeenCalledWith(true);
        for (let i = 0; i < 4; i++) {
            await vi.advanceTimersByTimeAsync(10000);
            expect(signal.aborted).toBe(false);
            stream.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
            await drain();
        }
        expect(fetch).toHaveBeenCalledOnce();
        h.stop();
        await drain();
        expect(signal.aborted).toBe(true);
    });

    it("times out an agenda stream that never receives headers", async () => {
        hangRequests();
        const h = agendaStream();
        await drain();
        await vi.advanceTimersByTimeAsync(30000);
        expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
        expect(h.onConnection).not.toHaveBeenCalledWith(true);
        await vi.advanceTimersByTimeAsync(1000);
        expect(fetch).toHaveBeenCalledTimes(2);
        h.stop();
        await drain();
    });

    it("combines the caller's cancellation with the timeout without adding HTTP status", async () => {
        const fetch = hangRequests();
        const controller = new AbortController();
        const cancelled = api.request(
            { serverUrl: "https://recorder.example", apiKey: "op_test" },
            "/api/v1/recorder/config",
            { signal: controller.signal },
        );
        controller.abort();
        await expect(cancelled).rejects.toBe(controller.signal.reason);
        expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    });
});
