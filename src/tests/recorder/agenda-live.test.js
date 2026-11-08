import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeAgenda } from "../../../extensions/recorder/lib/agenda-live.js";

vi.mock("../../../extensions/recorder/lib/token-vault.js", () => ({
    readToken: async () => "test-token",
}));
let local;
let stop;
beforeEach(() => {
    vi.useFakeTimers();
    local = {
        serverUrl: "https://recorder.example.com",
        dataUseAcknowledgedAt: "now",
        encryptedApiKey: { nonce: [1] },
        serverDefaults: { agendas: true, agendaLive: true },
    };
    vi.stubGlobal("chrome", { storage: { local: { get: async () => local } } });
    vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
    stop?.();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("panel-owned authenticated live stream", () => {
    it("does not open a stream on old servers", async () => {
        local.serverDefaults.agendaLive = false;
        stop = subscribeAgenda("one", { invalidate: vi.fn() });
        await settle();
        expect(fetch).not.toHaveBeenCalled();
    });
    it("authenticates with a header, parses split frames and refetches every invalidation including zero", async () => {
        const invalidate = vi.fn(async () => {});
        const onConnection = vi.fn();
        let feed;
        fetch.mockResolvedValue(
            new Response(
                new ReadableStream({
                    start(controller) {
                        feed = controller;
                    },
                }),
                { headers: { "Content-Type": "text/event-stream" } },
            ),
        );
        stop = subscribeAgenda("one", { invalidate, onConnection });
        await settle();
        expect(fetch.mock.calls[0][0]).toBe(
            "https://recorder.example.com/api/v1/recorder/agendas/one/events",
        );
        expect(fetch.mock.calls[0][1].headers.get("Authorization")).toBe(
            "Bearer test-token",
        );
        expect(invalidate).not.toHaveBeenCalled();
        expect(onConnection).not.toHaveBeenCalledWith(true);
        const encoder = new TextEncoder();
        feed.enqueue(encoder.encode(': connected\n\ndata: {"type":"agenda",'));
        await settle();
        feed.enqueue(
            encoder.encode(
                '"cursor":"0"}\n\ndata: {"type":"agenda","cursor":"0"}\n\n',
            ),
        );
        await settle();
        expect(invalidate).toHaveBeenCalledTimes(3);
        expect(onConnection).toHaveBeenCalledWith(true);
        stop();
        expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    });
    it("honors 429 Retry-After, reports downtime for polling and refetches on reconnect", async () => {
        const invalidate = vi.fn(async () => {});
        const connection = vi.fn();
        fetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ error: "Capacity" }), {
                    status: 429,
                    headers: { "Retry-After": "25" },
                }),
            )
            .mockResolvedValueOnce(
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(
                                new TextEncoder().encode(": connected\n\n"),
                            );
                        },
                    }),
                    {
                        headers: { "Content-Type": "text/event-stream" },
                    },
                ),
            );
        stop = subscribeAgenda("one", { invalidate, onConnection: connection });
        await settle();
        expect(connection).toHaveBeenLastCalledWith(false);
        await vi.advanceTimersByTimeAsync(24999);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(invalidate).toHaveBeenCalledTimes(1);
    });
    it("backs off after failures and stops reconnecting after revocation", async () => {
        fetch.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(
            new Response(JSON.stringify({ error: "Revoked" }), {
                status: 403,
            }),
        );
        stop = subscribeAgenda("one", { invalidate: vi.fn() });
        await settle();
        await vi.advanceTimersByTimeAsync(999);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetch).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(60000);
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});
