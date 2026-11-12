import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    panelRoomHeartbeat,
    sessionRoom,
} from "../../../extensions/recorder/lib/agenda-rooms.js";

const settings = {
    hasApiKey: true,
    dataUseAcknowledgedAt: "now",
    serverUrl: "https://example.com",
    connectionId: "one",
    serverDefaults: { agendas: true, agendaRooms: 1 },
};
const tab = {
    id: 7,
    url: "https://meet.google.com/meet/abc-defg-hij?authuser=1",
};
let heartbeat;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
    heartbeat?.stop();
    vi.useRealTimers();
});

describe("capability-gated room presence", () => {
    it.each([
        {},
        { serverDefaults: { agendas: true } },
        { ...settings, serverDefaults: { agendas: true } },
    ])("sends neither a session code nor presence without the flag", async (old) => {
        const send = vi.fn();
        heartbeat = panelRoomHeartbeat(send);
        heartbeat.update(old, tab, "agenda");
        await vi.advanceTimersByTimeAsync(180000);
        expect(send).not.toHaveBeenCalled();
        expect(sessionRoom(old, tab)).toEqual({});
    });
    it("starts on open, sends only code and selection, and repeats at sixty seconds", async () => {
        const send = vi.fn(async () => ({ ok: true }));
        heartbeat = panelRoomHeartbeat(send);
        heartbeat.update(settings, tab, null);
        await vi.advanceTimersByTimeAsync(59999);
        expect(send).toHaveBeenCalledExactlyOnceWith({
            type: "room-presence",
            tabId: 7,
            roomCode: "abc-defg-hij",
            agendaId: null,
        });
        heartbeat.update(settings, tab, null);
        await vi.advanceTimersByTimeAsync(1);
        expect(send).toHaveBeenCalledTimes(2);
        expect(sessionRoom(settings, tab)).toEqual({
            meetCode: "abc-defg-hij",
        });
        expect(JSON.stringify(send.mock.calls)).not.toContain("authuser");
    });
    it("sends an agenda change immediately and obeys the database write throttle", async () => {
        const send = vi
            .fn(async () => ({ retryAfterMs: 0 }))
            .mockResolvedValueOnce({ retryAfterMs: 20000 });
        heartbeat = panelRoomHeartbeat(send);
        heartbeat.update(settings, tab, "one");
        await vi.advanceTimersByTimeAsync(19999);
        expect(send).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(send).toHaveBeenCalledTimes(2);
        heartbeat.update(settings, tab, "two");
        await vi.advanceTimersByTimeAsync(0);
        expect(send).toHaveBeenLastCalledWith(
            expect.objectContaining({ agendaId: "two" }),
        );
    });
    it.each([
        "close",
        "navigate",
        "capability",
    ])("stops network heartbeats on %s", async (mode) => {
        const send = vi.fn(async () => ({ ok: true }));
        heartbeat = panelRoomHeartbeat(send);
        heartbeat.update(settings, tab, "agenda");
        await vi.advanceTimersByTimeAsync(0);
        if (mode === "close") heartbeat.stop();
        else
            heartbeat.update(
                mode === "capability"
                    ? { ...settings, serverDefaults: {} }
                    : settings,
                mode === "navigate"
                    ? { ...tab, url: "https://example.com" }
                    : tab,
                "agenda",
            );
        await vi.advanceTimersByTimeAsync(180000);
        expect(send).toHaveBeenCalledTimes(1);
    });
    it("does not resurrect the timer when an in-flight request finishes after close", async () => {
        let finish;
        const send = vi.fn(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        heartbeat = panelRoomHeartbeat(send);
        heartbeat.update(settings, tab, "agenda");
        heartbeat.stop();
        finish({ retryAfterMs: 1000 });
        await vi.advanceTimersByTimeAsync(180000);
        expect(send).toHaveBeenCalledTimes(1);
    });
    it("sends a room transition with its new code and keeps the latest selection during a slow heartbeat", async () => {
        let finish;
        const send = vi
            .fn(async () => ({}))
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    }),
            );
        heartbeat = panelRoomHeartbeat(send);
        heartbeat.update(settings, tab, "one");
        heartbeat.update(
            settings,
            { ...tab, url: "https://meet.google.com/xyz-abcd-efg" },
            "two",
        );
        finish({});
        await vi.advanceTimersByTimeAsync(0);
        expect(send).toHaveBeenLastCalledWith({
            type: "room-presence",
            tabId: 7,
            roomCode: "xyz-abcd-efg",
            agendaId: "two",
        });
    });
});
