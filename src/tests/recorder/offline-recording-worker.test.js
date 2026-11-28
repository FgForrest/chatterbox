import { beforeEach, expect, it, vi } from "vitest";
import { reportConnection } from "../../../extensions/recorder/lib/server-connection.js";
import vectors from "../fixtures/recorder-sealed-vectors.json";
import {
    extension,
    h,
    message,
    offscreen,
    settle,
    startFromPopup,
} from "./meeting-worker-fixture.js";

const serverUrl = "https://recorder.example";
const auth = { serverUrl, connectionId: "1.2.3" };
const recipient = {
    serverOrigin: serverUrl,
    accountId: "paired-account",
    kid: vectors.kid,
    alg: "ECDH-P256-HKDF-SHA256-A256GCM",
    publicKey: vectors.recipient.publicKey,
};
const sealing = {
    protocol: 2,
    kid: vectors.kid,
    ephemeralPublicKey: vectors.ephemeral.publicKey,
    salt: vectors.salt,
};
const stoppedAt = "2026-11-28T09:00:00.000Z";
const options = {
    ...extension,
    url: "chrome-extension://test/options/options.html",
};

function config() {
    return {
        encrypted_recording_protocol: 1,
        account: { id: recipient.accountId },
        features: {
            offlineRecording: 1,
            agendas: true,
            sessionAgenda: true,
            agendaRooms: 1,
        },
        offlineKey: recipient,
    };
}

function disconnected(value) {
    if (value)
        h.session.serverConnection = {
            ...auth,
            state: "unreachable",
            checkedAt: 1,
            detail: { kind: "network" },
        };
    else delete h.session.serverConnection;
}

function event(type, fields = {}) {
    const captureId = h.session.recordingState.captureId;
    h.listeners.message({ type, captureId, ...fields }, offscreen, () => {});
}

async function stop() {
    const { captureId } = h.session.recordingState;
    const result = await message(
        { type: "stop-recording", captureId },
        extension,
    );
    expect(result.ok).toBe(true);
    event("recording-stopped", { stoppedAt, chunkCount: 1 });
    await vi.waitFor(() => expect(h.session.recordingState.stopped).toBe(true));
}

beforeEach(() => {
    h.local.encryptedApiKey = { nonce: [1, 2, 3] };
    Object.assign(h.local.serverDefaults, {
        accountId: recipient.accountId,
        offlineRecording: true,
        offlineRecipient: recipient,
        agendas: true,
        sessionAgenda: true,
        agendaRooms: 1,
    });
    h.getRecorderConfig.mockResolvedValue(config());
    h.listLocalSessions.mockImplementation(async () => [...h.metas.keys()]);
    h.listChunkIndices.mockResolvedValue([0]);
    h.completeSession.mockResolvedValue({ job_id: "job" });
    h.getSession.mockImplementation(async (_auth, id) => ({
        id,
        status: "open",
        received_chunks: [],
    }));
    chrome.runtime.sendMessage.mockImplementation(async (request) => {
        if (
            request.type === "start" &&
            ["offscreen", "desktop-recorder"].includes(request.target)
        ) {
            const meta = h.metas.get(request.payload.captureId);
            if (request.payload.recipient) meta.sealing = sealing;
        }
        if (request.type === "ping")
            return { captureId: request.payload.captureId, recording: true };
        return { ok: true };
    });
});

it("requests and hands off the tab stream before creating a session or fetching the selected agenda", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
        const getId =
            chrome.tabCapture.getMediaStreamId.getMockImplementation();
        chrome.tabCapture.getMediaStreamId.mockImplementationOnce(
            (args, callback) => {
                expect(chrome.offscreen.createDocument).toHaveBeenCalledOnce();
                expect(h.createSealedSession).not.toHaveBeenCalled();
                expect(h.getRecorderConfig).not.toHaveBeenCalled();
                getId(args, callback);
            },
        );
        expect(
            await startFromPopup({
                agendaId: "cached-agenda",
                folderId: "cached-folder",
            }),
        ).toMatchObject({ ok: true });
        await vi.waitFor(() =>
            expect(h.createSealedSession).toHaveBeenCalledOnce(),
        );
        expect(h.createSession).not.toHaveBeenCalled();
        expect(h.getRecorderConfig).not.toHaveBeenCalled();
        const [, body] = h.createSealedSession.mock.calls[0];
        expect(body).toMatchObject({
            encryption: sealing,
            liveAgendaId: "cached-agenda",
            folderId: "cached-folder",
            meetCode: "abc-defg-hij",
        });
        expect(h.session.recordingState).toMatchObject({
            protocol: 2,
            sessionId: "sealed-session",
        });
    } finally {
        fetch.mockRestore();
    }
});

it("uses sealed capture for a panel start after the picker has selected its source", async () => {
    const panel = {
        ...extension,
        url: "chrome-extension://test/agenda/agenda.html?tab=7",
    };
    expect(
        await message(
            {
                type: "start-recording",
                payload: {
                    tabId: 7,
                    forceDesktop: true,
                    noticeAcknowledgedAt: stoppedAt,
                },
            },
            panel,
        ),
    ).toMatchObject({ ok: true, pending: true });
    expect(h.createSealedSession).not.toHaveBeenCalled();
    expect(h.createSession).not.toHaveBeenCalled();
    const { pickerRequestId } = h.session.recordingState;
    const picker = {
        ...extension,
        url: `chrome-extension://test/picker/picker.html?requestId=${pickerRequestId}`,
        tab: { windowId: 77 },
    };
    expect(
        await message(
            { type: "desktop-capture-ready", requestId: pickerRequestId },
            picker,
        ),
    ).toMatchObject({ ok: true });
    await vi.waitFor(() =>
        expect(h.createSealedSession).toHaveBeenCalledOnce(),
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
            type: "start",
            target: "desktop-recorder",
            payload: expect.objectContaining({ recipient }),
        }),
    );
    expect(chrome.tabCapture.getMediaStreamId).not.toHaveBeenCalled();
});

it.each([
    "clicked",
    "command",
])("uses offline-capable capture for a %s invocation", async (entry) => {
    h.local.autoModeAcknowledgedAt = stoppedAt;
    h.session.armedTabs = { 7: { mode: "auto" } };
    if (entry === "clicked") h.listeners.clicked(h.tabs.get(7));
    else await h.listeners.command("toggle-recording");
    await vi.waitFor(() =>
        expect(h.createSealedSession).toHaveBeenCalledOnce(),
    );
    expect(h.createSession).not.toHaveBeenCalled();
    expect(chrome.tabCapture.getMediaStreamId).toHaveBeenCalledOnce();
});

it("keeps recording at worker wake, then stops offline and sends folder and agenda with Complete", async () => {
    disconnected(true);
    const result = await startFromPopup({
        agendaId: "cached-agenda",
        folderId: "cached-folder",
    });
    expect(result.ok).toBe(true);
    expect(
        (await message({ type: "get-state" }, extension)).state,
    ).toMatchObject({ protocol: 2, stopped: false, sessionId: null });
    await stop();
    expect(h.session.recordingState).toMatchObject({
        stopped: true,
        chunkCount: 1,
    });
    expect(h.createSealedSession).not.toHaveBeenCalled();
    await reportConnection(auth, null);
    await vi.waitFor(() =>
        expect(h.completeSession).toHaveBeenCalledWith(
            expect.anything(),
            "sealed-session",
            expect.objectContaining({
                chunkCount: 1,
                endedAt: stoppedAt,
                folderId: "cached-folder",
                agendaId: "cached-agenda",
            }),
        ),
    );
    const [, body] = h.createSealedSession.mock.calls[0];
    expect(body).not.toHaveProperty("folderId");
    expect(body).not.toHaveProperty("liveAgendaId");
    expect(body).not.toHaveProperty("meetCode");
});

it.each([
    404, 405,
])("re-probes after a %s and retries the immutable descriptor after the server returns", async (status) => {
    h.getRecorderConfig.mockResolvedValueOnce({
        encrypted_recording_protocol: 1,
    });
    h.createSealedSession.mockRejectedValueOnce(
        Object.assign(new Error("No route"), { status, kind: "capability" }),
    );
    expect((await startFromPopup()).ok).toBe(true);
    await vi.waitFor(() =>
        expect(h.local.serverDefaults.offlineRecording).toBe(false),
    );
    expect(h.session.recordingState).toMatchObject({
        stopped: false,
        sessionId: null,
        blocked: false,
    });
    await stop();
    const { captureId } = h.session.recordingState;
    expect(h.metas.get(captureId)).toMatchObject({ sealing, stoppedAt });
    expect(
        (await message({ type: "retry-buffer", bufferId: captureId }, options))
            .ok,
    ).toBe(true);
    await vi.waitFor(() => expect(h.completeSession).toHaveBeenCalled());
    const first = h.createSealedSession.mock.calls[0][1];
    const retry = h.createSealedSession.mock.calls[1][1];
    expect(retry).toMatchObject({
        encryption: first.encryption,
        clientRecordingId: first.clientRecordingId,
        startedAt: first.startedAt,
        noticeAcknowledgedAt: first.noticeAcknowledgedAt,
    });
    expect(retry).not.toHaveProperty("meetCode");
    expect(h.createSession).not.toHaveBeenCalled();
});

it("retries an ambiguous create reply with the same sealed capture identity", async () => {
    h.createSealedSession.mockRejectedValueOnce(
        Object.assign(new Error("Timeout"), { kind: "unreachable" }),
    );
    expect((await startFromPopup()).ok).toBe(true);
    await vi.waitFor(() =>
        expect([...h.metas.values()][0]?.nextRetryAt).toBeTruthy(),
    );
    const meta = h.metas.get(h.session.recordingState.captureId);
    meta.nextRetryAt = new Date(0).toISOString();
    await h.listeners.alarm({ name: "upload-retry" });
    expect(h.createSealedSession).toHaveBeenCalledTimes(2);
    expect(h.createSealedSession.mock.calls[1][1]).toEqual(
        h.createSealedSession.mock.calls[0][1],
    );
    expect(h.createSession).not.toHaveBeenCalled();
});

it.each([
    true,
    false,
])("keeps committed audio after a sealed refusal (during capture: %s)", async (duringCapture) => {
    const response = Promise.withResolvers();
    h.createSealedSession.mockReturnValueOnce(response.promise);
    expect((await startFromPopup()).ok).toBe(true);
    await vi.waitFor(() =>
        expect(h.createSealedSession).toHaveBeenCalledOnce(),
    );
    if (!duringCapture) {
        const id = h.session.recordingState.captureId;
        await message({ type: "stop-recording", captureId: id }, extension);
        event("recording-stopped", { stoppedAt, chunkCount: 1 });
        await vi.waitFor(() =>
            expect(h.session.recordingState.stopped).toBe(true),
        );
    }
    response.reject(
        Object.assign(new Error("Key is gone"), {
            status: 410,
            kind: "server",
            code: "OFFLINE_KEY_UNAVAILABLE",
        }),
    );
    const { captureId } = h.session.recordingState;
    await vi.waitFor(() =>
        expect(h.metas.get(captureId)?.refusal).toEqual({
            code: "OFFLINE_KEY_UNAVAILABLE",
            message: "Key is gone",
        }),
    );
    if (duringCapture) {
        await vi.waitFor(() =>
            expect(h.session.recordingState.captureStopping).toBe(true),
        );
        event("recording-stopped", { stoppedAt, chunkCount: 1 });
        await vi.waitFor(() =>
            expect(h.session.recordingState.stopped).toBe(true),
        );
    }
    await vi.waitFor(() =>
        expect(h.session.recordingState).toMatchObject({
            blocked: true,
            stopped: true,
            state: "error",
        }),
    );
    expect(h.metas.get(captureId).chunkCount).toBe(1);
});

it.each([
    1, 2,
])("stops protocol %s offline after opening its session and completes once online", async (protocol) => {
    if (protocol === 1) h.local.serverDefaults.offlineRecording = false;
    expect((await startFromPopup()).ok).toBe(true);
    await vi.waitFor(() =>
        expect(h.session.recordingState.sessionId).toBeTruthy(),
    );
    disconnected(true);
    await stop();
    expect(h.session.recordingState).toMatchObject({ protocol, stopped: true });
    expect(h.completeSession).not.toHaveBeenCalled();
    await reportConnection(auth, null);
    await vi.waitFor(() =>
        expect(h.completeSession).toHaveBeenCalledWith(
            expect.anything(),
            protocol === 1 ? "session-1" : "sealed-session",
            expect.objectContaining({ endedAt: stoppedAt }),
        ),
    );
});

async function startAfterAmbiguousCreate() {
    h.createSealedSession.mockRejectedValueOnce(
        Object.assign(new Error("Timeout"), { kind: "unreachable" }),
    );
    expect((await startFromPopup({ agendaId: "cached-agenda" })).ok).toBe(true);
    await vi.waitFor(() =>
        expect([...h.metas.values()][0]?.nextRetryAt).toBeTruthy(),
    );
    return h.session.recordingState.captureId;
}

it("aborts the session an ambiguous sealed create may have committed before discarding the buffer", async () => {
    const captureId = await startAfterAmbiguousCreate();
    await stop();

    expect(
        await message({ type: "discard-buffer", bufferId: captureId }, options),
    ).toEqual({ ok: true });

    await vi.waitFor(() => expect(h.metas.has(captureId)).toBe(false));
    expect(h.abortSession).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        "sealed-session",
        expect.any(AbortSignal),
        { capture: true },
    );
    const [[, original], [, replay]] = h.createSealedSession.mock.calls;
    expect(original).toMatchObject({
        liveAgendaId: "cached-agenda",
        meetCode: "abc-defg-hij",
    });
    expect(replay).toMatchObject({ encryption: sealing });
    expect(replay).not.toHaveProperty("liveAgendaId");
    expect(replay).not.toHaveProperty("meetCode");
});

it("discards the audio offline and aborts the ambiguous sealed create on reconnect", async () => {
    const captureId = await startAfterAmbiguousCreate();
    await stop();
    disconnected(true);

    expect(
        await message({ type: "discard-buffer", bufferId: captureId }, options),
    ).toEqual({ ok: true });

    expect(h.metas.get(captureId)).toMatchObject({
        cleanupPending: true,
        sealing,
    });
    expect(h.createSealedSession).toHaveBeenCalledOnce();
    expect(h.abortSession).not.toHaveBeenCalled();
    expect(h.uploadChunk).not.toHaveBeenCalled();
    expect(
        await message({ type: "retry-buffer", bufferId: captureId }, options),
    ).toMatchObject({ ok: false });
    await reportConnection(auth, null);
    await vi.waitFor(() => expect(h.metas.has(captureId)).toBe(false));
    expect(h.abortSession).toHaveBeenCalledOnce();
});

it("aborts the session an ambiguous sealed create may have committed when the capture stops empty", async () => {
    h.listChunkIndices.mockResolvedValue([]);
    const captureId = await startAfterAmbiguousCreate();

    await message({ type: "stop-recording", captureId }, extension);
    event("recording-stopped", { stoppedAt, chunkCount: 0 });

    await vi.waitFor(() => expect(h.metas.has(captureId)).toBe(false));
    expect(h.abortSession).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        "sealed-session",
        expect.any(AbortSignal),
        { capture: true },
    );
});

it("discards an unbound recording locally when paired to another account", async () => {
    disconnected(true);
    expect((await startFromPopup()).ok).toBe(true);
    await stop();
    const { captureId } = h.session.recordingState;
    h.local.serverDefaults.accountId = "other-account";
    expect(
        (await message({ type: "retry-buffer", bufferId: captureId }, options))
            .ok,
    ).toBe(false);
    expect(
        (
            await message(
                { type: "discard-buffer", bufferId: captureId },
                options,
            )
        ).ok,
    ).toBe(true);
    expect(h.metas.has(captureId)).toBe(false);
    expect(h.createSealedSession).not.toHaveBeenCalled();
    expect(h.abortSession).not.toHaveBeenCalled();
});

it("keeps empty cleanup through an outage while the original sealed create is in flight", async () => {
    h.listChunkIndices.mockResolvedValue([]);
    const create = Promise.withResolvers();
    h.createSealedSession.mockReturnValueOnce(create.promise);
    expect((await startFromPopup({ agendaId: "cached-agenda" })).ok).toBe(true);
    await vi.waitFor(() =>
        expect(h.createSealedSession).toHaveBeenCalledOnce(),
    );
    const { captureId } = h.session.recordingState;
    disconnected(true);
    await message({ type: "stop-recording", captureId }, extension);
    event("recording-stopped", { stoppedAt, chunkCount: 0 });
    try {
        await vi.waitFor(() =>
            expect(h.metas.get(captureId)).toMatchObject({
                cleanupPending: true,
                sealing,
            }),
        );
    } finally {
        create.resolve({
            id: "sealed-session",
            status: "open",
            encryption: { protocol: 2, kid: sealing.kid },
        });
    }
    await reportConnection(auth, null);
    await vi.waitFor(() => expect(h.metas.has(captureId)).toBe(false));
    expect(h.abortSession).toHaveBeenCalledOnce();
    expect(h.uploadChunk).not.toHaveBeenCalled();
});

it("lets a new capture start while a discarded sealed create waits for its network deadline", async () => {
    const captureId = await startAfterAmbiguousCreate();
    await stop();
    const replay = Promise.withResolvers();
    h.createSealedSession.mockImplementationOnce((_auth, _body, signal) => {
        if (signal)
            signal.addEventListener(
                "abort",
                () => replay.reject(signal.reason),
                { once: true },
            );
        return replay.promise;
    });
    const discard = message(
        { type: "discard-buffer", bufferId: captureId },
        options,
    );
    try {
        await vi.waitFor(() =>
            expect(h.createSealedSession).toHaveBeenCalledTimes(2),
        );
        const signal = h.createSealedSession.mock.calls[1][2];
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(await startFromPopup()).toMatchObject({ ok: true });
        expect(await discard).toEqual({ ok: true });
        await vi.waitFor(() => expect(signal.aborted).toBe(true), {
            timeout: 4000,
        });
    } finally {
        replay.reject(new Error("Unavailable"));
        await discard;
    }
    expect(h.metas.get(captureId)).toMatchObject({ cleanupPending: true });
}, 6000);

it("keeps a gapped upgraded capture until the owner explicitly saves the playable beginning", async () => {
    const captureId = "released-buffer";
    h.metas.set(captureId, {
        captureId,
        protocol: 1,
        serverSessionId: captureId,
        serverUrl: h.local.serverUrl,
        verifiedPrefix: 0,
        startedAt: stoppedAt,
    });
    h.listChunkIndices.mockResolvedValue([0, 2]);
    await h.listeners.alarm({ name: "upload-retry" });
    expect(h.metas.get(captureId)).toMatchObject({
        verifiedPrefix: 0,
        highestCommittedIndex: 2,
    });
    expect(h.completeSession).not.toHaveBeenCalled();
    expect(
        await message({ type: "retry-buffer", bufferId: captureId }, options),
    ).toMatchObject({ ok: false, error: "recordingBufferGap" });
    expect(h.completeSession).not.toHaveBeenCalled();
    expect(
        await message(
            { type: "save-buffer-prefix", bufferId: captureId },
            options,
        ),
    ).toEqual({ ok: true });
    await vi.waitFor(() =>
        expect(h.completeSession).toHaveBeenCalledWith(
            expect.anything(),
            captureId,
            expect.objectContaining({ chunkCount: 3, truncatedAtChunk: 1 }),
        ),
    );
});

it("does not write capture A's completion over capture B after local cleanup stalls", async () => {
    expect((await startFromPopup()).ok).toBe(true);
    await vi.waitFor(() =>
        expect(h.session.recordingState.sessionId).toBe("sealed-session"),
    );
    const retired = h.session.recordingState.captureId;
    h.getSession.mockResolvedValue({
        id: "sealed-session",
        status: "completed",
        recording_id: "recording-a",
    });
    const cleanup = Promise.withResolvers();
    const entered = Promise.withResolvers();
    h.deleteLocalSession.mockImplementationOnce(async (id) => {
        entered.resolve();
        await cleanup.promise;
        h.metas.delete(id);
    });
    await stop();
    await entered.promise;
    try {
        expect((await startFromPopup()).ok).toBe(true);
        expect(h.session.recordingState.captureId).not.toBe(retired);
    } finally {
        cleanup.resolve();
    }
    await vi.waitFor(() => expect(h.metas.has(retired)).toBe(false));
    await settle();
    expect(h.session.recordingState).toMatchObject({
        state: "recording",
        stopped: false,
        recordingUrl: null,
    });
});

it.each([
    {},
    { encryption: { protocol: 2, kid: "different-key" } },
])("keeps waiting on a sealed replacement without a matching echo (%j)", async (echo) => {
    const captureId = "sealed-buffer";
    h.metas.set(captureId, {
        captureId,
        protocol: 2,
        sealing,
        serverSessionId: "old",
        serverUrl: h.local.serverUrl,
        pairing: {
            serverOrigin: serverUrl,
            accountId: recipient.accountId,
            connectionId: auth.connectionId,
        },
        stoppedAt,
        chunkCount: 1,
    });
    h.getSession.mockResolvedValue({ id: "old", status: "aborted" });
    h.recoverSession.mockResolvedValue({
        id: "replacement",
        status: "open",
        received_chunks: [],
        ...echo,
    });
    await h.listeners.alarm({ name: "upload-retry" });
    expect(h.recoverSession).toHaveBeenCalled();
    expect(h.metas.get(captureId)).toMatchObject({ serverSessionId: "old" });
    expect(h.uploadChunk).not.toHaveBeenCalled();
    expect(h.completeSession).not.toHaveBeenCalled();
});

it.each([
    1, 2,
])("keeps the initial protocol %i if the capability changes before capture", async (protocol) => {
    h.local.serverDefaults.offlineRecording = protocol === 2;
    const permission = Promise.withResolvers();
    const entered = Promise.withResolvers();
    navigator.permissions.query.mockImplementationOnce(() => {
        entered.resolve();
        return permission.promise;
    });
    const start = startFromPopup();
    await entered.promise;
    h.local.serverDefaults = {
        ...h.local.serverDefaults,
        offlineRecording: protocol === 1,
    };
    permission.resolve({ state: "granted" });
    expect(await start).toMatchObject({ ok: true });
    expect(h.session.recordingState.protocol).toBe(protocol);
});

it("keeps the selected agenda title in session storage only", async () => {
    h.session.recorderAgendaSelection = {
        serverUrl,
        connectionId: auth.connectionId,
        target: "null",
        at: Date.now(),
        explicit: true,
        agenda: { id: "cached-agenda", title: "Private agenda" },
    };
    expect((await startFromPopup({ agendaId: "cached-agenda" })).ok).toBe(true);
    const { captureId } = h.session.recordingState;
    expect(h.session.recordingState.agendaTitle).toBe("Private agenda");
    expect(h.metas.get(captureId)).toHaveProperty("agendaId", "cached-agenda");
    expect(h.metas.get(captureId)).not.toHaveProperty("agendaTitle");
});

function stoppedSealedCapture(captureId, patch = {}) {
    const meta = {
        captureId,
        protocol: 2,
        sealing,
        serverSessionId: "sealed-session",
        pairing: {
            serverOrigin: serverUrl,
            accountId: recipient.accountId,
            connectionId: auth.connectionId,
        },
        stoppedAt,
        chunkCount: 1,
        highestCommittedIndex: 0,
        verifiedPrefix: 0,
        ...patch,
    };
    h.metas.set(captureId, meta);
    h.listChunkIndices.mockImplementation(async (id) =>
        h.metas.get(id)?.chunkCount ? [0] : [],
    );
    return meta;
}

const discardBuffer = (bufferId) =>
    message({ type: "discard-buffer", bufferId }, options);
const reconcile = () => h.listeners.alarm({ name: "upload-retry" });

it("retains audio when Discard races Complete and reports when finalization wins", async () => {
    const id = "completing-capture";
    stoppedSealedCapture(id);
    const complete = Promise.withResolvers();
    let dispatched;
    h.completeSession.mockImplementationOnce(() => {
        dispatched = h.metas.get(id)?.completeDispatched;
        return complete.promise;
    });
    h.abortSession.mockRejectedValueOnce(
        Object.assign(new Error("Finalizing"), {
            status: 409,
            code: "CONFLICT",
        }),
    );
    const upload = reconcile();
    try {
        await vi.waitFor(() =>
            expect(h.completeSession).toHaveBeenCalledOnce(),
        );
        expect(await discardBuffer(id)).toEqual({
            ok: false,
            error: "discardStillFinalizing",
        });
        expect(dispatched).toBe(true);
        expect(await h.listChunkIndices(id)).toEqual([0]);
    } finally {
        complete.resolve({ status: "completing", job_id: "job" });
        await upload;
    }
    h.abortSession.mockResolvedValueOnce("completed");
    expect(await discardBuffer(id)).toEqual({
        ok: false,
        error: "discardAlreadySaved",
    });
    expect(h.metas.has(id)).toBe(false);
});

it("keeps an uncertain Complete after restart until cancellation is confirmed", async () => {
    const id = "uncertain-complete";
    stoppedSealedCapture(id, { completeDispatched: true });
    const cancel = Promise.withResolvers();
    h.abortSession
        .mockResolvedValueOnce(undefined)
        .mockReturnValueOnce(cancel.promise);
    expect(await discardBuffer(id)).toEqual({
        ok: false,
        error: "discardUnconfirmed",
    });
    const discard = discardBuffer(id);
    try {
        await vi.waitFor(() => expect(h.abortSession).toHaveBeenCalledTimes(2));
        expect(await h.listChunkIndices(id)).toEqual([0]);
        expect(h.session.recordingState).toBeUndefined();
    } finally {
        cancel.resolve("discarded");
        await discard;
    }
    expect(await discard).toEqual({ ok: true });
    expect(h.metas.has(id)).toBe(false);
    expect(h.completeSession).not.toHaveBeenCalled();
});

it("keeps the stopped capture in the panel when a discarded buffer's Retry gets old receipts", async () => {
    const id = "stale-retry";
    const next = "stopped-in-panel";
    stoppedSealedCapture(id);
    stoppedSealedCapture(next, { serverSessionId: "next-session" });
    h.session.recordingState = {
        captureId: next,
        protocol: 2,
        sessionId: "next-session",
        state: "error",
        stopped: true,
        blocked: true,
    };
    const receipts = Promise.withResolvers();
    h.getSession.mockReturnValueOnce(receipts.promise);
    const retry = message({ type: "retry-buffer", bufferId: id }, options);
    try {
        await vi.waitFor(() => expect(h.getSession).toHaveBeenCalledOnce());
        expect(await discardBuffer(id)).toEqual({ ok: true });
        await vi.waitFor(() => expect(h.metas.has(id)).toBe(false));
    } finally {
        receipts.resolve({
            id: "sealed-session",
            status: "open",
            received_chunks: [0],
        });
        await retry;
    }
    expect(h.session.recordingState.captureId).toBe(next);
    expect(await retry).toEqual({ ok: false, error: "recoveryUnavailable" });
});

it("fences dispatch when Discard runs while the uploader is reading a chunk", async () => {
    const id = "reading-chunk";
    stoppedSealedCapture(id);
    const read = Promise.withResolvers();
    h.readChunk.mockReturnValueOnce(read.promise);
    const upload = reconcile();
    try {
        await vi.waitFor(() => expect(h.readChunk).toHaveBeenCalledOnce());
        expect(await discardBuffer(id)).toEqual({ ok: true });
        expect(await h.listChunkIndices(id)).toEqual([]);
    } finally {
        read.resolve(new Blob(["encrypted"]));
        await upload;
    }
    expect(h.uploadChunk).not.toHaveBeenCalled();
});

it("aborts a dispatched PUT as soon as its capture is discarded", async () => {
    const id = "sending-chunk";
    stoppedSealedCapture(id);
    const put = Promise.withResolvers();
    h.uploadChunk.mockImplementationOnce(
        (_auth, _id, _index, _blob, _hash, signal) => {
            signal?.addEventListener("abort", () => put.reject(signal.reason), {
                once: true,
            });
            return put.promise;
        },
    );
    const upload = reconcile();
    try {
        await vi.waitFor(() => expect(h.uploadChunk).toHaveBeenCalledOnce());
        expect(await discardBuffer(id)).toEqual({ ok: true });
        expect(h.uploadChunk.mock.calls[0][5]?.aborted).toBe(true);
        expect(await h.listChunkIndices(id)).toEqual([]);
    } finally {
        put.resolve();
        await upload;
    }
    expect(h.completeSession).not.toHaveBeenCalled();
});

it("cleans an empty sealed capture when startup finds its Stop already persisted", async () => {
    const id = "stopped-empty";
    stoppedSealedCapture(id, {
        chunkCount: 0,
        highestCommittedIndex: -1,
        verifiedPrefix: -1,
    });
    h.listeners.startup();
    await vi.waitFor(() => expect(h.metas.has(id)).toBe(false));
    expect(h.abortSession).toHaveBeenCalledOnce();
    expect(h.uploadChunk).not.toHaveBeenCalled();
});

it("cancels the open replacement when the locally bound session is already aborted", async () => {
    const id = "lost-recovery-response";
    stoppedSealedCapture(id, { serverSessionId: "old" });
    let replacement = "open";
    h.abortSession.mockImplementationOnce(
        async (_auth, requested, _signal, opts) => {
            expect(requested).toBe("old");
            if (!opts?.capture)
                throw Object.assign(new Error("Already aborted"), {
                    status: 409,
                });
            replacement = "aborted";
        },
    );
    h.getSession.mockResolvedValue({ id: "old", status: "aborted" });
    expect(await discardBuffer(id)).toEqual({ ok: true });
    await vi.waitFor(() => expect(h.metas.has(id)).toBe(false));
    expect(replacement).toBe("aborted");
});

it("removes audio while a queued sealed create is still awaiting its response", async () => {
    const id = "queued-create";
    stoppedSealedCapture(id, {
        serverSessionId: null,
        createIntent: { clientRecordingId: "client-id" },
    });
    const create = Promise.withResolvers();
    const cleanup = Promise.withResolvers();
    h.createSealedSession
        .mockReturnValueOnce(create.promise)
        .mockReturnValueOnce(cleanup.promise);
    const upload = reconcile();
    let discard;
    try {
        await vi.waitFor(() =>
            expect(h.createSealedSession).toHaveBeenCalledOnce(),
        );
        discard = discardBuffer(id);
        await vi.waitFor(() =>
            expect(h.metas.get(id)?.cleanupPending).toBe(true),
        );
        expect(await h.listChunkIndices(id)).toEqual([]);
        expect(await discard).toEqual({ ok: true });
        expect(await startFromPopup()).toMatchObject({ ok: true });
    } finally {
        create.resolve({ id: "sealed-session", status: "open" });
        cleanup.resolve({ id: "sealed-session", status: "open" });
        await upload;
        await discard;
    }
});

it("persists the resolved session across a cleanup deadline before cancellation", async () => {
    const id = "cleanup-deadline";
    stoppedSealedCapture(id, {
        serverSessionId: null,
        createOutcome: "unknown",
        createIntent: { clientRecordingId: "client-id" },
    });
    const timeout = Promise.withResolvers();
    const controller = new AbortController();
    const deadline = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValueOnce(controller.signal);
    h.abortSession.mockImplementationOnce((_auth, _id, attemptSignal) => {
        attemptSignal.addEventListener(
            "abort",
            () => timeout.reject(attemptSignal.reason),
            { once: true },
        );
        return timeout.promise;
    });
    try {
        expect(await discardBuffer(id)).toEqual({ ok: true });
        await vi.waitFor(() => expect(h.abortSession).toHaveBeenCalledOnce());
        expect(deadline).toHaveBeenCalledWith(3_000);
        expect(h.abortSession.mock.calls[0][2]).toBe(controller.signal);
        expect(h.metas.get(id)).toMatchObject({
            cleanupPending: true,
            serverSessionId: "sealed-session",
            cleanupStep: "cancel",
        });
    } finally {
        controller.abort();
        deadline.mockRestore();
        await settle();
    }
    await reconcile();
    await vi.waitFor(() => expect(h.metas.has(id)).toBe(false));
    expect(h.createSealedSession).toHaveBeenCalledOnce();
    expect(h.abortSession).toHaveBeenCalledTimes(2);
});

it("parks a sealed replay on a confirmed rollback and resumes it when support returns", async () => {
    const id = "rollback-cleanup";
    stoppedSealedCapture(id, {
        serverSessionId: null,
        createOutcome: "unknown",
        createIntent: { clientRecordingId: "client-id" },
    });
    const oldValue = { ...h.local.serverDefaults, offlineRecording: false };
    h.local.serverDefaults = oldValue;
    expect(await discardBuffer(id)).toEqual({ ok: true });
    await reconcile();
    await settle();
    expect(h.metas.get(id)).toMatchObject({ cleanupPending: true });
    expect(h.createSealedSession).not.toHaveBeenCalled();
    const newValue = { ...oldValue, offlineRecording: true };
    h.local.serverDefaults = newValue;
    h.listeners.storage({ serverDefaults: { oldValue, newValue } }, "local");
    await vi.waitFor(() => expect(h.metas.has(id)).toBe(false));
    expect(h.createSealedSession).toHaveBeenCalledOnce();
});

it("retires an audio-free tombstone when a replacement credential gets a permanent 403", async () => {
    const id = "revoked-cleanup-key";
    stoppedSealedCapture(id);
    h.local.encryptedApiKey = { nonce: [4, 5, 6] };
    h.abortSession.mockRejectedValueOnce(
        Object.assign(new Error("Recorder key mismatch"), {
            status: 403,
            kind: "server",
            code: "RECORDER_KEY_MISMATCH",
        }),
    );
    expect(await discardBuffer(id)).toEqual({ ok: true });
    await vi.waitFor(() => expect(h.metas.has(id)).toBe(false));
    expect(h.abortSession).toHaveBeenCalledOnce();
});

it("keeps the tombstone through a reversible 403 and cancels after access returns", async () => {
    const id = "restricted-cleanup";
    stoppedSealedCapture(id);
    h.abortSession.mockRejectedValueOnce(
        Object.assign(new Error("Account restricted"), {
            status: 403,
            kind: "server",
            code: "FORBIDDEN",
        }),
    );
    expect(await discardBuffer(id)).toEqual({ ok: true });
    await settle();
    expect(h.abortSession).toHaveBeenCalledOnce();
    expect(h.metas.get(id)).toMatchObject({ cleanupPending: true });
    await reconcile();
    await vi.waitFor(() => expect(h.metas.has(id)).toBe(false));
    expect(h.abortSession).toHaveBeenCalledTimes(2);
});

it("preserves the next REC badge when Discard's tab reevaluation awaits microphone permission", async () => {
    disconnected(true);
    h.local.platformModes = { "google-meet": "off" };
    expect((await startFromPopup()).ok).toBe(true);
    await stop();
    const id = h.session.recordingState.captureId;
    const mic = Promise.withResolvers();
    const entered = Promise.withResolvers();
    navigator.permissions.query.mockImplementationOnce(() => {
        entered.resolve();
        return mic.promise;
    });
    const discard = discardBuffer(id);
    try {
        await entered.promise;
        expect((await startFromPopup()).ok).toBe(true);
        expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({
            tabId: 7,
            text: "REC",
        });
    } finally {
        mic.resolve({ state: "granted" });
        await discard;
        await settle();
    }
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({
        tabId: 7,
        text: "REC",
    });
});

it("preserves the next capture's badge and title when an older Discard finishes its reset", async () => {
    disconnected(true);
    expect((await startFromPopup()).ok).toBe(true);
    await stop();
    const id = h.session.recordingState.captureId;
    const banner = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const send = chrome.tabs.sendMessage.getMockImplementation();
    chrome.tabs.sendMessage.mockImplementationOnce(async (...args) => {
        entered.resolve();
        await banner.promise;
        return send(...args);
    });
    const discard = discardBuffer(id);
    try {
        await entered.promise;
        expect((await startFromPopup()).ok).toBe(true);
        expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({
            tabId: 7,
            text: "REC",
        });
        expect(chrome.action.setTitle).toHaveBeenLastCalledWith({
            tabId: 7,
            title: "recordingTitle",
        });
    } finally {
        banner.resolve();
        await discard;
    }
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({
        tabId: 7,
        text: "REC",
    });
    expect(chrome.action.setTitle).toHaveBeenLastCalledWith({
        tabId: 7,
        title: "recordingTitle",
    });
});

it("accepts a duplicate Discard of a removed capture while a new capture records", async () => {
    const id = "already-discarded";
    stoppedSealedCapture(id);
    expect(await discardBuffer(id)).toEqual({ ok: true });
    await vi.waitFor(() => expect(h.metas.has(id)).toBe(false));
    expect((await startFromPopup()).ok).toBe(true);
    const next = h.session.recordingState.captureId;
    expect(await discardBuffer(id)).toEqual({ ok: true });
    expect(h.session.recordingState.captureId).toBe(next);
    expect(h.metas.has(next)).toBe(true);
});
