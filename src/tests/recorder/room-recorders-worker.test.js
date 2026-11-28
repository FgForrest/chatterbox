import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    extension,
    h,
    message,
    offscreen,
    settle,
} from "./meeting-worker-fixture.js";

const tabId = 7;
const captureId = "tab-capture";
const sessionId = "server-session";
const names = ["Robin Harper", "Jitka Dvořáková"];
const lookup = (id = tabId, sender = extension) =>
    message({ type: "room-recorders", tabId: id }, sender);
const emit = (type, fields = {}, sender = offscreen) =>
    h.listeners.message({ type, captureId, ...fields }, sender, () => {});

const wallStart = 1_800_000_000_000;
const monotonicNow = () => performance.timeOrigin + performance.now();
let now;
let confirmHost;
beforeEach(() => {
    now = wallStart;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(performance, "now").mockImplementation(() => now - wallStart);
    h.tabs.get(tabId).active = true;
    h.local.serverDefaults.roomRecorders = 1;
    h.local.encryptedApiKey.nonce = [1];
    h.listeners.storage({ encryptedApiKey: {} }, "local");
    h.lookupRoomRecorders
        .mockReset()
        .mockImplementation(async () => ({ names, freshForMs: 60_000 }));
    h.postRecordingLease.mockReset().mockResolvedValue(undefined);
    confirmHost = vi.fn(async () => ({ captureId, recording: true }));
    chrome.runtime.sendMessage.mockImplementation(async (request) =>
        request.type === "ping" ? confirmHost() : { ok: true },
    );
});

afterEach(async () => {
    await settle();
    vi.restoreAllMocks();
});

async function navigate(url) {
    const tab = { ...h.tabs.get(tabId), url };
    h.tabs.set(tabId, tab);
    await h.listeners.updated(tabId, { url }, tab);
}

function live(patch = {}) {
    const state = {
        state: "recording",
        stopped: false,
        captureId,
        sessionId,
        tabId,
        captureMode: "tab",
        uploaded: [],
        chunkCount: 0,
        ...patch,
    };
    h.session.recordingState = state;
    h.metas.set(captureId, {
        captureId,
        serverSessionId: state.sessionId,
        verifiedPrefix: -1,
        pairing: { serverOrigin: h.local.serverUrl, connectionId: "1" },
    });
}

async function chunk(index = 0) {
    emit("chunk-ready", { index });
    await settle();
}

function leases() {
    return h.postRecordingLease.mock.calls.map(([, id, revision, room]) => [
        id,
        revision,
        room,
    ]);
}

describe("room recorder lookups", () => {
    it("subtracts request time from server freshness even when the browser wall clock lags", async () => {
        let elapsed = 0;
        vi.mocked(performance.now).mockImplementation(() => elapsed);
        const pending = Promise.withResolvers();
        h.lookupRoomRecorders.mockReturnValueOnce(pending.promise);
        const result = lookup();
        await vi.waitFor(() =>
            expect(h.lookupRoomRecorders).toHaveBeenCalledOnce(),
        );
        elapsed = 1_000;
        now += elapsed;
        pending.resolve({ names, liveUntil: now + 22_000, freshForMs: 2_000 });
        expect(await result).toEqual({
            names,
            expiresAt: performance.timeOrigin + 2_000,
        });
        elapsed = 2_000;
        now -= 5_000;
        h.lookupRoomRecorders.mockResolvedValueOnce({
            names: [],
            liveUntil: null,
            freshForMs: 0,
        });
        expect((await lookup()).names).toEqual([]);
        expect(h.lookupRoomRecorders).toHaveBeenCalledTimes(2);
    });

    it("expires a positive result at its earliest lease and refreshes the lookup", async () => {
        h.lookupRoomRecorders.mockResolvedValueOnce({
            names,
            freshForMs: 2000,
        });
        expect(await lookup()).toEqual({
            names,
            expiresAt: monotonicNow() + 2000,
        });
        now += 2000;
        h.lookupRoomRecorders.mockResolvedValueOnce({
            names: [],
            freshForMs: 0,
        });
        expect(await lookup()).toMatchObject({ names: [] });
        expect(h.lookupRoomRecorders).toHaveBeenCalledTimes(2);
    });
    it("shares an in-flight lookup between popup and panel and caches it for thirty seconds per tab", async () => {
        const panel = {
            ...extension,
            url: "chrome-extension://test/agenda/agenda.html?tab=7",
        };
        const [popup, sidebar] = await Promise.all([
            lookup(),
            lookup(tabId, panel),
        ]);
        expect(popup).toEqual({ names, expiresAt: monotonicNow() + 30_000 });
        expect(sidebar).toEqual(popup);
        expect(h.lookupRoomRecorders).toHaveBeenCalledExactlyOnceWith(
            expect.anything(),
            "meet:abc-defg-hij",
        );
        now += 29_999;
        expect(await lookup()).toEqual(popup);
        h.tabs.set(8, { ...h.tabs.get(tabId), id: 8, windowId: 8 });
        expect(await lookup(8)).toMatchObject({ names });
        expect(h.lookupRoomRecorders).toHaveBeenCalledTimes(2);
        now++;
        expect(await lookup()).toEqual({
            names,
            expiresAt: monotonicNow() + 30_000,
        });
        expect(h.lookupRoomRecorders).toHaveBeenCalledTimes(3);
    });

    it.each([
        "navigation",
        "different room",
        "inactive tab",
        "pairing",
        "recording",
    ])("drops a pending answer after %s", async (change) => {
        const pending = Promise.withResolvers();
        h.lookupRoomRecorders.mockReturnValueOnce(pending.promise);
        const old = lookup();
        await vi.waitFor(() =>
            expect(h.lookupRoomRecorders).toHaveBeenCalledOnce(),
        );
        if (change === "navigation")
            await navigate("https://meet.google.com/meet/abc-defg-hij");
        if (change === "different room")
            h.tabs.get(tabId).url = "https://zoom.us/j/123456789";
        if (change === "inactive tab") h.tabs.get(tabId).active = false;
        if (change === "pairing") {
            const oldValue = h.local.encryptedApiKey;
            const newValue = { ...oldValue, nonce: [2] };
            h.local.encryptedApiKey = newValue;
            h.listeners.storage(
                { encryptedApiKey: { oldValue, newValue } },
                "local",
            );
        }
        if (change === "recording") live();
        pending.resolve({
            names: ["Previous colleague"],
            freshForMs: 60_000,
        });
        expect(await old).toEqual({});
        if (change !== "inactive tab" && change !== "recording") {
            expect(await lookup()).toMatchObject({ names });
            expect(h.lookupRoomRecorders).toHaveBeenCalledTimes(2);
        }
    });

    it("drops cached names on pairing changes even when the current room stays open", async () => {
        expect(await lookup()).toMatchObject({ names });
        h.local.encryptedApiKey = { nonce: [2] };
        h.listeners.storage(
            { encryptedApiKey: { newValue: h.local.encryptedApiKey } },
            "local",
        );
        h.lookupRoomRecorders.mockResolvedValue({
            names: ["New colleague"],
            freshForMs: 60_000,
        });
        expect(await lookup()).toMatchObject({ names: ["New colleague"] });
    });

    it.each([
        429,
        404,
        undefined,
    ])("fails silently with a bounded retry after %s", async (status) => {
        h.lookupRoomRecorders.mockRejectedValueOnce(
            Object.assign(new Error("Unavailable"), {
                status,
                ...(status === 429 ? { retryAfterSeconds: 90 } : {}),
            }),
        );
        expect((await lookup()).names ?? []).toEqual([]);
        for (const offset of [15_000, 15_000, 30_000]) {
            now += offset;
            if (status !== 429 && now >= wallStart + 30_000) break;
            expect((await lookup()).names ?? []).toEqual([]);
        }
        expect(h.lookupRoomRecorders).toHaveBeenCalledOnce();
        if (status === 429) {
            await navigate("https://zoom.us/j/123456789");
            expect(await lookup()).toEqual({});
            expect(h.lookupRoomRecorders).toHaveBeenCalledOnce();
            now += 30_000;
        }
        expect(await lookup()).toMatchObject({ names });
        expect(h.lookupRoomRecorders).toHaveBeenCalledTimes(2);
        expect(h.session.serverConnection).toBeUndefined();
    });

    it.each([
        "feature off",
        "unpaired",
        "no room",
        "other extension page",
    ])("skips lookup when %s", async (condition) => {
        if (condition === "feature off")
            delete h.local.serverDefaults.roomRecorders;
        if (condition === "unpaired") delete h.local.encryptedApiKey;
        if (condition === "no room")
            h.tabs.get(tabId).url = "https://example.com/";
        const sender =
            condition === "other extension page" ? offscreen : extension;
        expect(await lookup(tabId, sender)).toEqual({});
        expect(h.lookupRoomRecorders).not.toHaveBeenCalled();
    });
});

describe("capture leases", () => {
    it.each([
        false,
        true,
    ])("renews a replacement after an old refusal (in flight: %s) and honors Stop", async (inFlight) => {
        live();
        const renewal = Promise.withResolvers();
        const refusal = Object.assign(new Error("Refused"), {
            code: "RECORDING_LEASE_REFUSED",
        });
        if (inFlight) h.postRecordingLease.mockReturnValueOnce(renewal.promise);
        else h.postRecordingLease.mockRejectedValueOnce(refusal);
        await chunk();
        h.session.recordingState.reconcilePending = true;
        h.listLocalSessions.mockResolvedValueOnce([captureId]);
        h.getSession.mockResolvedValueOnce({
            id: sessionId,
            status: "aborted",
        });
        h.recoverSession.mockResolvedValueOnce({
            id: "replacement",
            status: "open",
        });
        await h.listeners.alarm({ name: "upload-retry" });
        expect(h.session.recordingState.sessionId).toBe("replacement");
        if (inFlight) renewal.reject(refusal);
        await settle();
        await chunk(1);
        expect(leases()).toEqual([
            [sessionId, 1, "meet:abc-defg-hij"],
            ["replacement", 2, "meet:abc-defg-hij"],
        ]);
        await message({ type: "stop-recording", captureId }, extension);
        await settle();
        expect(h.metas.get(captureId).lease).toMatchObject({ ended: true });
        now += 20_000;
        await chunk(2);
        expect(leases()).toHaveLength(3);
    });
    it("throttles chunk-driven renewals and persists ordered revisions through moves, clears and re-entry", async () => {
        live();
        await chunk();
        expect(leases()).toEqual([[sessionId, 1, "meet:abc-defg-hij"]]);
        expect(h.metas.get(captureId).lease).toEqual({
            sessionId,
            revision: 1,
            attemptedAt: now,
        });
        await navigate("https://zoom.us/j/123456789?pwd=example");
        for (const [index, elapsed] of [
            [1, 5_000],
            [2, 5_000],
            [3, 9_999],
        ]) {
            now += elapsed;
            await chunk(index);
        }
        expect(leases()).toHaveLength(1);
        now++;
        await chunk(4);
        await navigate("https://example.com/");
        now += 20_000;
        await chunk(5);
        now += 20_000;
        await chunk(6);
        await navigate("https://meet.google.com/abc-defg-hij");
        await chunk(7);
        expect(leases()).toEqual([
            [sessionId, 1, "meet:abc-defg-hij"],
            [sessionId, 2, "zoom:123456789"],
            [sessionId, 3, null],
            [sessionId, 4, "meet:abc-defg-hij"],
        ]);
        expect(h.metas.get(captureId).lease).toEqual({
            sessionId,
            revision: 4,
            attemptedAt: now,
        });
    });

    it("resumes throttling and revision order from the persisted lease", async () => {
        live();
        h.metas.get(captureId).lease = {
            revision: 8,
            attemptedAt: now - 15_000,
        };
        await chunk();
        expect(leases()).toEqual([]);
        now += 5_000;
        await chunk(1);
        expect(leases()).toEqual([[sessionId, 9, "meet:abc-defg-hij"]]);
    });

    it("reads the current tab after a delayed host confirmation", async () => {
        live();
        const ping = Promise.withResolvers();
        confirmHost.mockReturnValueOnce(ping.promise);
        await chunk();
        await navigate("https://zoom.us/j/123456789");
        ping.resolve({ captureId, recording: true });
        await vi.waitFor(() =>
            expect(leases()).toEqual([[sessionId, 1, "zoom:123456789"]]),
        );
    });

    it("cancels the first renewal when Stop arrives during host confirmation", async () => {
        live();
        const pending = Promise.withResolvers();
        confirmHost.mockReturnValueOnce(pending.promise);
        await chunk();
        expect(confirmHost).toHaveBeenCalledOnce();
        expect(
            await message({ type: "stop-recording", captureId }, extension),
        ).toEqual({ ok: true });
        pending.resolve({ captureId, recording: true });
        await settle();
        expect(leases()).toEqual([]);
        expect(h.metas.get(captureId).lease).toBeUndefined();
    });

    it.each([
        "feature off",
        "no session",
        "inactive host",
        "wrong host",
        "picker",
        "untrusted chunk",
    ])("never renews with %s", async (condition) => {
        live(
            condition === "picker"
                ? { captureMode: "desktop" }
                : condition === "no session"
                  ? { sessionId: null }
                  : {},
        );
        if (condition === "feature off")
            delete h.local.serverDefaults.roomRecorders;
        if (condition === "inactive host")
            confirmHost.mockResolvedValue({ captureId, recording: false });
        if (condition === "wrong host")
            confirmHost.mockResolvedValue({
                captureId: "another",
                recording: true,
            });
        if (condition === "untrusted chunk") {
            emit("chunk-ready", { index: 0 }, extension);
            await settle();
        } else await chunk();
        expect(leases()).toEqual([]);
    });

    it("waits for the next eligible chunk after a network error and stops after refusal", async () => {
        live();
        h.postRecordingLease
            .mockRejectedValueOnce(new TypeError("Failed to fetch"))
            .mockRejectedValueOnce(
                Object.assign(new Error("Refused"), {
                    code: "RECORDING_LEASE_REFUSED",
                }),
            );
        await chunk();
        now += 19_999;
        await chunk(1);
        expect(leases()).toHaveLength(1);
        now++;
        await chunk(2);
        expect(h.metas.get(captureId).lease).toMatchObject({
            sessionId,
            revision: 2,
            refused: true,
        });
        now += 20_000;
        await chunk(3);
        expect(leases()).toHaveLength(2);
        expect(h.session.recordingState.uploadNotice).toBeFalsy();
        expect(h.session.serverConnection).toBeUndefined();
    });

    it.each([
        "Stop",
        "quiet alarm",
        "stream ended",
        "tab closed",
        "host error",
        "host stopped",
        "missing host",
        "Discard",
        "Complete",
    ])("ends the lease on %s", async (action) => {
        live();
        await chunk();
        switch (action) {
            case "Stop":
                await message({ type: "stop-recording", captureId }, extension);
                break;
            case "quiet alarm":
                h.tabs.get(tabId).audible = false;
                h.session.recordingState.autoStarted = true;
                await h.listeners.alarm({ name: `quiet:${tabId}` });
                break;
            case "stream ended":
                emit("stream-ended");
                break;
            case "tab closed":
                await h.listeners.tabRemoved(tabId);
                break;
            case "host error":
                emit("capture-error", { message: "Capture failed" });
                break;
            case "host stopped":
                emit("recording-stopped", { chunkCount: 1 });
                break;
            case "missing host":
                confirmHost.mockResolvedValue({
                    captureId: null,
                    recording: false,
                });
                await message({ type: "get-state" }, extension);
                break;
            case "Discard":
                Object.assign(h.session.recordingState, {
                    state: "error",
                    stopped: true,
                });
                h.getSession.mockResolvedValue({ status: "open" });
                await message(
                    { type: "discard-session", captureId },
                    extension,
                );
                break;
            case "Complete":
                Object.assign(h.session.recordingState, {
                    chunkCount: 1,
                    stopped: true,
                    uploaded: [0],
                });
                h.completeSession.mockResolvedValue({ status: "completing" });
                h.getSession.mockResolvedValue({ status: "completing" });
                await message(
                    { type: "check-finalization", captureId },
                    extension,
                );
                expect(h.completeSession).toHaveBeenCalled();
                break;
        }
        await settle();
        expect(leases()).toEqual([
            [sessionId, 1, "meet:abc-defg-hij"],
            [sessionId, 2, undefined],
        ]);
        now += 20_000;
        await chunk(1);
        expect(leases()).toHaveLength(2);
    });

    it("does not wait for an in-flight renewal or end request to Stop", async () => {
        live();
        const renew = Promise.withResolvers();
        const end = Promise.withResolvers();
        h.postRecordingLease
            .mockReturnValueOnce(renew.promise)
            .mockReturnValueOnce(end.promise);
        try {
            await chunk();
            expect(leases()).toHaveLength(1);
            expect(
                await message({ type: "stop-recording", captureId }, extension),
            ).toEqual({ ok: true });
            await vi.waitFor(() => expect(leases()).toHaveLength(2));
            expect(h.metas.get(captureId).lease).toMatchObject({
                revision: 2,
                ended: true,
            });
        } finally {
            renew.resolve();
            end.reject(new Error("Network unavailable"));
        }
    });
});
