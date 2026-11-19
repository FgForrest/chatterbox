import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    abortSession,
    completeSession,
    createSession,
    getSession,
    recoverSession,
    request,
    setSessionAgenda,
    uploadChunk,
} from "../../../extensions/recorder/lib/api.js";
import { ALARMS } from "../../../extensions/recorder/lib/constants.js";
import {
    NEXT_MEETING_KEY,
    refreshNextMeeting,
} from "../../../extensions/recorder/lib/next-meeting.js";
import { refreshServerConfig } from "../../../extensions/recorder/lib/pairing.js";

const h = vi.hoisted(() => {
    const local = {};
    const session = {};
    const listeners = {};
    const meta = new Map();
    const chunks = new Map();
    const alarms = new Map();
    const tabs = new Map();
    const event = (key) => ({
        addListener(fn) {
            listeners[key] = fn;
        },
    });
    function area(data) {
        return {
            get: async (keys) =>
                keys == null
                    ? structuredClone(data)
                    : Object.fromEntries(
                          [keys]
                              .flat()
                              .map((key) => [key, structuredClone(data[key])]),
                      ),
            set: async (patch) => Object.assign(data, structuredClone(patch)),
            remove: async (keys) => {
                for (const key of [keys].flat()) delete data[key];
            },
            setAccessLevel: async () => {},
        };
    }
    const noop = async () => {};
    vi.stubGlobal("chrome", {
        i18n: { getMessage: (key) => key },
        storage: {
            local: area(local),
            session: area(session),
            onChanged: event("storage"),
        },
        runtime: {
            id: "test",
            getURL: (path) => `chrome-extension://test/${path}`,
            getManifest: () => ({ version: "0.9.10" }),
            getContexts: vi.fn(async () => []),
            sendMessage: vi.fn(async () => ({ ok: true })),
            openOptionsPage: vi.fn(noop),
            onMessage: event("message"),
            onMessageExternal: event("external"),
            onStartup: event("startup"),
            onInstalled: event("installed"),
        },
        tabs: {
            get: async (id) => tabs.get(id),
            query: async () => [...tabs.values()],
            sendMessage: vi.fn(async () => ({ visible: true })),
            onUpdated: event("tab-updated"),
            onRemoved: event("tab-removed"),
        },
        commands: { onCommand: event("command"), getAll: async () => [] },
        alarms: {
            create: vi.fn(async (name, value) => alarms.set(name, value)),
            get: async (name) => alarms.get(name),
            getAll: async () => [],
            clear: async (name) => alarms.delete(name),
            onAlarm: event("alarm"),
        },
        action: {
            onClicked: event("click"),
            setPopup: vi.fn(noop),
            setTitle: noop,
            setBadgeText: noop,
            setBadgeBackgroundColor: noop,
            getUserSettings: async () => ({ isOnToolbar: true }),
        },
        scripting: { getRegisteredContentScripts: async () => [] },
        notifications: {
            onClicked: event("notification"),
            onButtonClicked: event("notification-button"),
            clear: noop,
            create: vi.fn(noop),
        },
        permissions: {
            onAdded: event("added"),
            onRemoved: event("removed"),
            contains: async () => true,
        },
        windows: { onRemoved: event("window-removed") },
        tabCapture: { getMediaStreamId: (_options, done) => done("stream") },
        offscreen: { createDocument: vi.fn(noop), closeDocument: vi.fn(noop) },
    });
    return { local, session, listeners, meta, chunks, alarms, tabs };
});

vi.mock("../../../extensions/recorder/lib/token-vault.js", () => ({
    readToken: async () => "op_test",
}));
vi.mock("../../../extensions/recorder/lib/chunk-store.js", () => ({
    createLocalSession: async (id, value) => h.meta.set(id, value),
    readLocalMeta: async (id) => h.meta.get(id),
    deleteLocalSession: async (id) => h.meta.delete(id),
    listLocalSessions: async () => [...h.meta.keys()],
    listChunkIndices: async (id) => h.chunks.get(id) ?? [],
    readChunk: async () => new Blob(["encrypted"]),
    totalBufferedBytes: async () => 0,
}));
vi.mock("../../../extensions/recorder/lib/meeting-prompt.js", () => ({
    hasMeetingPromptAccess: async () => true,
    injectMeetingPrompt: async () => {},
    isPromptMeeting: (url) => url?.startsWith("https://meet.google.com/"),
    reconcileMeetingPrompt: async () => {},
    meetingPromptPermissionChanged: () => false,
}));

import "../../../extensions/recorder/service-worker.js";

const auth = { serverUrl: "https://recorder.example", apiKey: "op_test" };
const popup = { id: "test", url: "chrome-extension://test/popup/popup.html" };
const options = {
    id: "test",
    url: "chrome-extension://test/options/options.html",
};
const panel = {
    id: "test",
    url: "chrome-extension://test/agenda/agenda.html?tab=7",
};
const tab = {
    id: 7,
    url: "https://meet.google.com/abc-defg-hij",
    audible: true,
};
const alarm = "recorder-connection-probe";
const foreign = (status) => new Response("<html>Proxy</html>", { status });
const apiError = (status, code) =>
    Response.json({ error: "Server refused", code }, { status });
const config = () => Response.json({ encrypted_recording_protocol: 1 });
const send = (type, values = {}, sender = popup) =>
    new Promise((resolve) =>
        h.listeners.message({ type, ...values }, sender, resolve),
    );
const stopEvent = () =>
    h.listeners.message(
        { type: "recording-stopped", sessionId: "session-one", chunkCount: 1 },
        {},
        vi.fn(),
    );
let fetchMock;

beforeEach(() => {
    vi.clearAllMocks();
    for (const store of [h.local, h.session]) {
        for (const key of Object.keys(store)) delete store[key];
    }
    for (const store of [h.meta, h.chunks, h.alarms, h.tabs]) store.clear();
    Object.assign(h.local, {
        dataUseAcknowledgedAt: "yes",
        serverUrl: auth.serverUrl,
        encryptedApiKey: { nonce: [1, 2, 3] },
        serverDefaults: { encryptedRecordingProtocol: 1 },
    });
    vi.stubGlobal("navigator", {
        onLine: true,
        permissions: { query: async () => ({ state: "granted" }) },
    });
    chrome.runtime.getContexts.mockResolvedValue([]);
    fetchMock = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("recorder request outcomes", () => {
    it.each([
        true,
        false,
    ])("classifies a dropped connection when navigator.onLine is %s", async (online) => {
        navigator.onLine = online;
        fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
        const error = await request(auth, "/test").catch((error) => error);
        expect(error).toMatchObject({
            kind: online ? "unreachable" : "offline",
            detail: { kind: "network" },
        });
        expect(error).not.toHaveProperty("status");
        expect(error.message).not.toContain("Failed to fetch");
    });

    it("classifies its own deadline and preserves a caller's cancellation", async () => {
        vi.useFakeTimers();
        fetchMock.mockImplementation(() => new Promise(() => {}));
        const timedOut = request(auth, "/test", {}, 30_000).catch(
            (error) => error,
        );
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await timedOut).toMatchObject({
            kind: "unreachable",
            detail: { kind: "timeout", timeoutMs: 30_000 },
        });
        const caller = new AbortController();
        const cancelled = request(auth, "/test", {
            signal: caller.signal,
        }).catch((error) => error);
        caller.abort();
        const error = await cancelled;
        expect(error.name).toBe("AbortError");
        expect(error).not.toHaveProperty("kind");
    });

    it.each([
        "timeout",
        "caller",
    ])("observes late fetch rejection after %s aborts", async (kind) => {
        vi.useFakeTimers();
        const caller = new AbortController();
        const late = Promise.withResolvers();
        fetchMock.mockReturnValueOnce(late.promise);
        const result = request(
            auth,
            "/test",
            { signal: caller.signal },
            30_000,
        ).catch((error) => error);
        if (kind === "caller") caller.abort();
        else await vi.advanceTimersByTimeAsync(30_000);
        expect(await result).toMatchObject(
            kind === "caller"
                ? { name: "AbortError" }
                : { kind: "unreachable" },
        );
        late.reject(new DOMException("Fetch aborted late", "AbortError"));
        await vi.advanceTimersByTimeAsync(0);
        // Vitest reports any unhandled rejection after the request has settled.
    });

    it.each([
        () => createSession(auth, {}),
        () =>
            uploadChunk(
                auth,
                "session-one",
                0,
                new Blob(["encrypted"]),
                "hash",
            ),
        () => completeSession(auth, "session-one", {}),
        () => getSession(auth, "session-one"),
        () => recoverSession(auth, "session-one"),
        () => abortSession(auth, "session-one"),
        () => setSessionAgenda(auth, "session-one", "agenda-one"),
    ])("rejects foreign JSON from a recording session route", async (call) => {
        fetchMock.mockResolvedValue(
            Response.json({ error: "Sign in to continue" }),
        );
        await expect(call()).rejects.toMatchObject({
            kind: "unreachable",
            detail: { kind: "foreign-response", httpStatus: 200 },
        });
    });

    it.each([
        { error: "Sign in to continue" },
        { encrypted_recording_protocol: "1" },
        { encrypted_recording_protocol: 1, features: [] },
        { encrypted_recording_protocol: 1, defaults: null },
    ])("rejects foreign config %j before changing health or defaults", async (body) => {
        const defaults = { encryptedRecordingProtocol: 1, agendas: true };
        h.local.serverDefaults = defaults;
        fetchMock.mockResolvedValueOnce(Response.json(body));
        await expect(refreshServerConfig()).rejects.toMatchObject({
            kind: "unreachable",
            httpStatus: 200,
        });
        expect(h.local.serverDefaults).toEqual(defaults);
        expect(h.session.serverConnection.state).toBe("unreachable");

        fetchMock.mockResolvedValue(config());
        await expect(refreshServerConfig()).resolves.toBe(true);
        expect(h.session.serverConnection.state).toBe("ok");
        expect(h.local.serverDefaults.encryptedRecordingProtocol).toBe(1);
    });

    it.each([
        200, 403, 404, 502,
    ])("treats HTML HTTP %i as foreign", async (status) => {
        fetchMock.mockResolvedValue(foreign(status));
        const error = await request(auth, "/test").catch((error) => error);
        expect(error).toMatchObject({
            kind: "unreachable",
            httpStatus: status,
            detail: { kind: "foreign-response" },
        });
        expect(error).not.toHaveProperty("status");
        expect(error).not.toHaveProperty("code");
    });

    it.each([
        { error: "Proxy" },
        { code: "FORBIDDEN" },
    ])("requires both fields in a JSON error body", async (body) => {
        fetchMock.mockResolvedValue(Response.json(body, { status: 403 }));
        const error = await request(auth, "/test").catch((error) => error);
        expect(error).toMatchObject({ kind: "unreachable", httpStatus: 403 });
        expect(error).not.toHaveProperty("status");
    });

    it.each([
        [401, "UNAUTHORIZED"],
        [403, "FORBIDDEN"],
        [404, "NOT_FOUND"],
        [503, "ACCESS_UNVERIFIABLE"],
    ])("preserves the server's %i %s envelope", async (status, code) => {
        fetchMock.mockResolvedValue(
            Response.json(
                {
                    error: "Server refused",
                    code,
                    details: { field: "folderId" },
                },
                { status },
            ),
        );
        await expect(request(auth, "/test")).rejects.toMatchObject({
            kind: "server",
            status,
            code,
            field: "folderId",
        });
    });

    it.each([
        true,
        false,
    ])("honors Retry-After with envelope=%s", async (envelope) => {
        fetchMock.mockResolvedValue(
            new Response(
                envelope
                    ? JSON.stringify({
                          error: "Slow down",
                          code: "RATE_LIMITED",
                      })
                    : "<html>Proxy</html>",
                {
                    status: 429,
                    headers: { "Retry-After": "25" },
                },
            ),
        );
        const error = await request(auth, "/test").catch((error) => error);
        expect(error.retryAfterSeconds).toBe(25);
        expect(error.kind).toBe(envelope ? "server" : "unreachable");
        if (envelope) expect(error.status).toBe(429);
        else expect(error).not.toHaveProperty("status");
    });
});

function buffer({ stopped = false } = {}) {
    h.meta.set("buffer-one", {
        serverUrl: auth.serverUrl,
        serverSessionId: "session-one",
    });
    h.chunks.set("buffer-one", [0]);
    h.session.recordingState = {
        state: "recording",
        stopped,
        uploaded: [],
        chunkCount: stopped ? 1 : 0,
        sessionId: "session-one",
        bufferId: "buffer-one",
        captureMode: "tab",
        tabId: 7,
    };
}

function respondToRecovery(url, init) {
    if (url.endsWith("/config")) return config();
    if (url.endsWith("/session-one"))
        return Response.json(
            init.method === "DELETE" ? { success: true } : { status: "open" },
        );
    if (url.includes("/chunks/")) return Response.json({ index: 0 });
    return Response.json({ job_id: "job-one" });
}

describe("recorder worker outage recovery", () => {
    it.each([
        "timeout",
        "proxy",
    ])("keeps capture running and resumes after a %s", async (failure) => {
        buffer();
        chrome.runtime.getContexts.mockResolvedValue([
            { documentUrl: "chrome-extension://test/offscreen/offscreen.html" },
        ]);
        if (failure === "timeout") {
            vi.useFakeTimers();
            fetchMock.mockImplementation(() => new Promise(() => {}));
        } else fetchMock.mockImplementation(async () => foreign(403));
        h.listeners.message({ type: "chunk-ready" }, {}, vi.fn());
        if (failure === "timeout") {
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(120_000);
        }
        await vi.waitFor(() =>
            expect(h.meta.get("buffer-one").retryAttempt).toBe(1),
        );
        expect(h.session.serverConnection).toMatchObject({
            state: "unreachable",
            detail: {
                kind: failure === "timeout" ? "timeout" : "foreign-response",
            },
        });
        expect(h.session.recordingState.state).toBe("recording");
        expect(h.session.recordingState.blocked).toBeFalsy();
        expect(await send("stop-recording")).toEqual({ ok: true });
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ target: "offscreen", type: "stop" }),
        );
        stopEvent();
        await vi.waitFor(() =>
            expect(h.session.recordingState.stopped).toBe(true),
        );
        expect(chrome.offscreen.closeDocument).toHaveBeenCalledOnce();
        fetchMock.mockImplementation(async (...args) =>
            respondToRecovery(...args),
        );
        await h.listeners.alarm({ name: alarm });
        await vi.waitFor(() =>
            expect(h.session.recordingState.jobId).toBe("job-one"),
        );
        expect(h.session.recordingState.uploaded).toEqual([0]);
        expect(h.meta.get("buffer-one")).toMatchObject({
            retryAttempt: 0,
            nextRetryAt: null,
        });
        expect(h.session.serverConnection.state).toBe("ok");
    });

    it("stops a blocked capture even if it was already put in the error state", async () => {
        buffer();
        fetchMock.mockImplementation(async () =>
            apiError(403, "ACCESS_NOT_GRANTED"),
        );
        chrome.runtime.getContexts.mockResolvedValue([
            { documentUrl: "chrome-extension://test/offscreen/offscreen.html" },
        ]);
        h.listeners.message({ type: "chunk-ready" }, {}, vi.fn());
        await vi.waitFor(() =>
            expect(h.session.recordingState.blocked).toBe(true),
        );
        expect(h.session.recordingState.state).toBe("recording");
        h.session.recordingState.state = "error";
        await send("stop-recording");
        stopEvent();
        await vi.waitFor(() =>
            expect(h.session.recordingState.stopped).toBe(true),
        );
        expect(chrome.offscreen.closeDocument).toHaveBeenCalledOnce();
        expect(h.session.recordingState.error).toBe("accessWithdrawn");
    });

    it("schedules recovery for a startup buffer without an open extension page", async () => {
        vi.useFakeTimers();
        buffer({ stopped: true });
        delete h.session.recordingState;
        fetchMock.mockImplementation(async () => foreign(404));
        h.listeners.startup();
        await vi.waitFor(() =>
            expect(h.session.recordingState?.reconcilePending).toBe(true),
        );
        expect(h.session.recordingState).toMatchObject({
            blocked: false,
            stopped: true,
            state: "recording",
        });
        await vi.waitFor(() =>
            expect(h.alarms.get(alarm)).toEqual({ periodInMinutes: 0.5 }),
        );
        expect(h.meta.has("buffer-one")).toBe(true);
        fetchMock.mockImplementation(async (url, init) => {
            if (url.endsWith("/complete"))
                return Response.json({ job_id: "job-one" });
            if (url.endsWith("/session-one") && h.session.recordingState.jobId)
                return Response.json({
                    status: "completed",
                    recording_id: "recording-one",
                });
            return respondToRecovery(url, init);
        });
        await h.listeners.alarm({ name: alarm });
        await vi.waitFor(() =>
            expect(h.session.recordingState.state).toBe("completed"),
        );
        expect(h.meta.has("buffer-one")).toBe(false);
        await vi.advanceTimersByTimeAsync(4000);
        expect(h.session.recordingState).toBeUndefined();
        h.tabs.set(tab.id, tab);
        fetchMock.mockImplementation(async (url) =>
            url.endsWith("/config")
                ? config()
                : Response.json({
                      id: "session-new",
                      encryption: { protocol: 1, key: "test-key" },
                  }),
        );
        expect(
            await send("start-recording", {
                payload: { tabId: tab.id, noticeAcknowledgedAt: "now" },
            }),
        ).toMatchObject({ ok: true, sessionId: "session-new" });
    });

    it.each([
        "lookup",
        "presence",
    ])("signals Stop while agenda %s waits and finalizes after its metadata", async (pendingStep) => {
        buffer();
        h.local.serverDefaults = {
            ...h.local.serverDefaults,
            agendas: true,
            sessionAgenda: true,
        };
        const editResponse = Promise.withResolvers();
        const editStarted = vi.fn();
        const complete = vi.fn(() => Response.json({ job_id: "job-one" }));
        const agenda = {
            id: "agenda-one",
            title: "Acme review",
            own: true,
            permissions: { edit: true },
        };
        const pending = (step, body) => {
            if (step !== pendingStep) return Response.json(body);
            editStarted();
            return editResponse.promise.then(() => Response.json(body));
        };
        fetchMock.mockImplementation(async (url, init) => {
            if (url.endsWith("/agendas/agenda-one"))
                return pending("lookup", agenda);
            if (init.method === "PATCH")
                return pending("presence", { status: "open" });
            if (url.endsWith("/complete"))
                return complete(JSON.parse(init.body));
            return respondToRecovery(url, init);
        });
        const edit = send(
            "edit-agenda",
            { sessionId: "session-one", tabId: 7, agendaId: "agenda-one" },
            panel,
        );
        await vi.waitFor(() => expect(editStarted).toHaveBeenCalledOnce());
        const stop = send("stop-recording");
        try {
            await vi.waitFor(() =>
                expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
                    expect.objectContaining({
                        target: "offscreen",
                        type: "stop",
                    }),
                ),
            );
            stopEvent();
            await vi.waitFor(() =>
                expect(h.session.recordingState.stopped).toBe(true),
            );
            expect(complete).not.toHaveBeenCalled();
        } finally {
            editResponse.resolve();
            await Promise.all([stop, edit]);
        }
        await vi.waitFor(() =>
            expect(complete).toHaveBeenCalledWith(
                expect.objectContaining({ agendaId: "agenda-one" }),
            ),
        );
    });

    it("serializes recovery with Retry and Discard and never restores a discarded buffer", async () => {
        buffer({ stopped: true });
        delete h.session.recordingState;
        fetchMock.mockImplementation(async () => foreign(404));
        h.listeners.startup();
        await vi.waitFor(() => expect(h.alarms.has(alarm)).toBe(true));
        for (const type of ["retry-buffer", "discard-buffer"]) {
            expect(
                await send(type, { bufferId: "buffer-one" }, options),
            ).toMatchObject({ ok: false, connection: true });
        }

        const lookup = Promise.withResolvers();
        const get = vi
            .fn()
            .mockReturnValueOnce(lookup.promise)
            .mockImplementation(() => apiError(404, "NOT_FOUND"));
        fetchMock.mockImplementation(async (url, init) =>
            url.endsWith("/session-one") && init.method !== "DELETE"
                ? get()
                : respondToRecovery(url, init),
        );
        await h.listeners.alarm({ name: alarm });
        await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
        const discard = send(
            "discard-buffer",
            { bufferId: "buffer-one" },
            options,
        );
        try {
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(get).toHaveBeenCalledOnce();
        } finally {
            lookup.resolve(foreign(404));
            await discard;
        }
        expect(await discard).toEqual({ ok: true });
        expect(h.meta.has("buffer-one")).toBe(false);
        expect(h.session.recordingState).toBeUndefined();
    });

    it("clears stale state when a second Discard finds no buffer", async () => {
        buffer({ stopped: true });
        h.session.recordingState.reconcilePending = true;
        h.meta.delete("buffer-one");
        expect(
            await send("discard-buffer", { bufferId: "buffer-one" }, options),
        ).toEqual({ ok: true });
        expect(h.session.recordingState).toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
        401, 403, 404,
    ])("keeps the buffer and stops polling a finalization denied with HTTP %i", async (status) => {
        buffer({ stopped: true });
        Object.assign(h.session.recordingState, {
            state: "finalizing",
            jobId: "job-one",
        });
        fetchMock.mockImplementation(async () =>
            apiError(status, status === 403 ? "ACCESS_NOT_GRANTED" : "REFUSED"),
        );
        await h.listeners.alarm({ name: ALARMS.uploadRetry });
        expect(h.meta.has("buffer-one")).toBe(true);
        expect(h.session.recordingState).toMatchObject({
            state: "error",
            blocked: true,
            stopped: true,
            sessionId: "session-one",
        });
        expect(await send("check-finalization")).toEqual({ ok: true });
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(h.alarms.has(ALARMS.uploadRetry)).toBe(false);
        expect(
            await send("discard-buffer", { bufferId: "buffer-one" }, options),
        ).toEqual({ ok: true });
        expect(h.meta.has("buffer-one")).toBe(false);
    });

    it("keeps the processing view and schedules a retry after a transient finalization poll failure", async () => {
        buffer({ stopped: true });
        Object.assign(h.session.recordingState, {
            state: "finalizing",
            jobId: "job-one",
        });
        fetchMock.mockImplementation(async () =>
            apiError(503, "ACCESS_UNVERIFIABLE"),
        );
        expect(await send("check-finalization")).toEqual({ ok: true });
        expect(h.meta.has("buffer-one")).toBe(true);
        expect(h.session.recordingState.state).toBe("finalizing");
        expect(h.alarms.get(ALARMS.uploadRetry)).toEqual({ delayInMinutes: 1 });
    });

    it("shows an unavailable start and starts from the same consenting meeting after recovery", async () => {
        h.tabs.set(tab.id, tab);
        await h.listeners["tab-updated"](tab.id, { status: "complete" }, tab);
        fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
        await h.listeners.command("toggle-recording");
        expect(h.session.recordingState).toMatchObject({
            state: "error",
            startConnectionError: true,
            error: null,
        });
        expect(h.session.armedTabs[tab.id].promptVisible).toBe(true);
        expect(h.session.serverConnection.state).toBe("unreachable");
        fetchMock.mockImplementation(async (url) =>
            url.endsWith("/config")
                ? config()
                : Response.json({
                      id: "session-new",
                      encryption: { protocol: 1, key: "test-key" },
                  }),
        );
        await send("recorder-connection-retry");
        await h.listeners.command("toggle-recording");
        expect(h.session.recordingState).toMatchObject({
            state: "recording",
            sessionId: "session-new",
        });
        expect(chrome.runtime.openOptionsPage).not.toHaveBeenCalled();
    });

    it("keeps the next meeting and toolbar agenda route when background fetches fail", async () => {
        h.local.serverDefaults = {
            agendas: true,
            nextMeeting: true,
            agendaRooms: 1,
        };
        h.tabs.set(tab.id, tab);
        const agenda = {
            id: "agenda-one",
            title: "Acme review",
            roomBound: true,
        };
        fetchMock.mockImplementation(async () =>
            Response.json({ data: [agenda] }),
        );
        await h.listeners["tab-updated"](tab.id, { status: "complete" }, tab);
        expect(h.session["agenda-route:7"].agendaIds).toEqual(["agenda-one"]);
        h.session["agenda-match:7"].at = 0;
        const meeting = {
            serverUrl: auth.serverUrl,
            connectionId: "1.2.3",
            fetchedAt: 0,
            data: { title: "Acme review" },
        };
        h.session[NEXT_MEETING_KEY] = meeting;
        fetchMock.mockImplementation(async () => foreign(404));
        expect(await refreshNextMeeting()).toEqual(meeting);
        const calls = fetchMock.mock.calls.length;
        await h.listeners["tab-updated"](tab.id, { status: "complete" }, tab);
        expect(fetchMock).toHaveBeenCalledTimes(calls);
        expect(h.session["agenda-route:7"].agendaIds).toEqual(["agenda-one"]);
        expect(h.session[NEXT_MEETING_KEY]).toEqual(meeting);
    });
});
