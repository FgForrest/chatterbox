// @vitest-environment jsdom

import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toastApiError } from "@/lib/api-errors";
import { observeSessionExpiry } from "@/lib/auth/session-expiry";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
const originalFetch = window.fetch;
let stop = () => {};

afterEach(() => {
    stop();
    window.fetch = originalFetch;
    vi.clearAllMocks();
    vi.useRealTimers();
});

function observe(response: Response) {
    const fetch = vi.fn().mockResolvedValue(response);
    window.fetch = fetch;
    const expired = vi.fn();
    stop = observeSessionExpiry(expired);
    return { expired, fetch };
}

describe("session expiry fetch observer", () => {
    it.each([
        "string",
        "URL",
        "Request",
    ])("detects an app 401 with %s input and leaves its body readable", async (inputType) => {
        const body = { code: "AUTH_SESSION_MISSING", error: "Unauthorized" };
        const response = Response.json(body, { status: 401 });
        const { expired, fetch } = observe(response);
        const url = new URL("/api/x", window.location.href);
        const input =
            inputType === "string"
                ? "/api/x"
                : inputType === "URL"
                  ? url
                  : new Request(url);
        const init = { method: "POST" };
        const result = await window.fetch(input, init);
        await vi.waitFor(() => expect(expired).toHaveBeenCalledTimes(1));
        expect(result).toBe(response);
        expect(await result.json()).toEqual(body);
        expect(fetch).toHaveBeenCalledWith(input, init);
    });

    it.each([
        [401, "REAUTHENTICATION_REQUIRED", "/api/x"],
        [401, "ACCESS_NOT_GRANTED", "/api/x"],
        [401, "ACCOUNT_SUSPENDED", "/api/x"],
        [403, "AUTH_SESSION_MISSING", "/api/x"],
        [500, "AUTH_SESSION_MISSING", "/api/x"],
        [401, "AUTH_SESSION_MISSING", "/api/auth/get-session"],
        [401, "AUTH_SESSION_MISSING", "/api/auth"],
        [401, "AUTH_SESSION_MISSING", "https://evil.example/api/x"],
        [401, "AUTH_SESSION_MISSING", "/other"],
    ])("ignores %s %s at %s", async (status, code, url) => {
        const { expired } = observe(Response.json({ code }, { status }));
        await window.fetch(url);
        expect(expired).not.toHaveBeenCalled();
    });

    it("ignores cross-origin redirected responses", async () => {
        const response = Response.json(
            { code: "AUTH_SESSION_MISSING" },
            { status: 401 },
        );
        Object.defineProperty(response, "url", {
            value: "https://evil.example/api/x",
        });
        const { expired } = observe(response);
        await window.fetch("/api/x");
        expect(expired).not.toHaveBeenCalled();
    });

    it("preserves malformed responses and network failures", async () => {
        const { expired, fetch } = observe(
            new Response("not JSON", { status: 401 }),
        );
        expect(await (await window.fetch("/api/x")).text()).toBe("not JSON");
        fetch.mockRejectedValueOnce(new TypeError("Network unavailable"));
        await expect(window.fetch("/api/x")).rejects.toThrow(
            "Network unavailable",
        );
        expect(expired).not.toHaveBeenCalled();
    });

    it("does not signal for requests completing after cleanup", async () => {
        const { expired } = observe(
            Response.json({ code: "AUTH_SESSION_MISSING" }, { status: 401 }),
        );
        const pending = window.fetch("/api/x");
        stop();
        await pending;
        expect(expired).not.toHaveBeenCalled();
    });

    it("signals a watcher that subscribed while the request was in flight", async () => {
        let resolve: (response: Response) => void = () => {};
        window.fetch = vi.fn().mockReturnValue(
            new Promise<Response>((done) => {
                resolve = done;
            }),
        );
        const first = vi.fn();
        const late = vi.fn();
        const stopFirst = observeSessionExpiry(first);
        const pending = window.fetch("/api/x");
        const stopLate = observeSessionExpiry(late);
        stop = () => {
            stopFirst();
            stopLate();
        };
        resolve(
            Response.json({ code: "AUTH_SESSION_MISSING" }, { status: 401 }),
        );
        await pending;
        await vi.waitFor(() => {
            expect(first).toHaveBeenCalledOnce();
            expect(late).toHaveBeenCalledOnce();
        });
    });

    it("suppresses only this response's missing-session error", async () => {
        await toastApiError(
            Response.json(
                { code: "AUTH_SESSION_MISSING", error: "Unauthorized" },
                { status: 401 },
            ),
            { productName: "Acme" },
        );
        expect(toast.error).not.toHaveBeenCalled();
        for (const [status, code] of [
            [400, "AUTH_SESSION_MISSING"],
            [401, "PLAUD_TOKEN_INVALID"],
            [500, "INTERNAL_ERROR"],
        ] as const) {
            await toastApiError(
                Response.json({ code, error: "Failed" }, { status }),
                { productName: "Acme" },
            );
        }
        expect(toast.error).toHaveBeenCalledTimes(3);
    });

    it("keeps genuine errors visible after an observed expiry", async () => {
        const { expired } = observe(
            Response.json({ code: "AUTH_SESSION_MISSING" }, { status: 401 }),
        );
        await window.fetch("/api/x");
        await vi.waitFor(() => expect(expired).toHaveBeenCalledOnce());
        await toastApiError(
            Response.json(
                { code: "PLAUD_TOKEN_INVALID", error: "Reconnect" },
                { status: 401 },
            ),
            { productName: "Acme" },
        );
        expect(toast.error).toHaveBeenCalledWith("Reconnect");
    });

    it.each([
        "time",
        "size",
    ])("returns an unfinished response immediately and cancels inspection at the %s bound", async (bound) => {
        vi.useFakeTimers();
        const response = new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        new TextEncoder().encode(
                            '{"code":"AUTH_SESSION_MISSING"}',
                        ),
                    );
                },
            }),
            { status: 401 },
        );
        const clone = response.clone();
        const reader = clone.body?.getReader();
        if (!reader || !clone.body) throw new Error("Missing response stream");
        const cancel = vi.spyOn(reader, "cancel");
        vi.spyOn(clone.body, "getReader").mockReturnValue(reader);
        vi.spyOn(response, "clone").mockReturnValue(clone);
        if (bound === "size") {
            vi.spyOn(reader, "read").mockResolvedValue({
                done: false,
                value: new Uint8Array(16_385),
            });
        }
        const { expired } = observe(response);
        let returned: Response | undefined;
        void window.fetch("/api/x").then((value) => {
            returned = value;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(returned).toBe(response);
        expect(response.bodyUsed).toBe(false);
        if (bound === "time") {
            expect(cancel).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1_000);
        }
        expect(cancel).toHaveBeenCalledOnce();
        expect(expired).not.toHaveBeenCalled();
        void response.body?.cancel();
    });

    it.each([
        "first",
        "last",
    ])("shares one wrapper and restores fetch when the %s observer unmounts first", async (order) => {
        const fetch = vi
            .fn()
            .mockImplementation(() =>
                Promise.resolve(
                    Response.json(
                        { code: "AUTH_SESSION_MISSING" },
                        { status: 401 },
                    ),
                ),
            );
        window.fetch = fetch;
        const first = vi.fn();
        const second = vi.fn();
        const stopFirst = observeSessionExpiry(first);
        const wrapper = window.fetch;
        const stopSecond = observeSessionExpiry(second);
        stop = () => {
            stopFirst();
            stopSecond();
        };
        expect(window.fetch).toBe(wrapper);
        await window.fetch("/api/x");
        await vi.waitFor(() => {
            expect(first).toHaveBeenCalledOnce();
            expect(second).toHaveBeenCalledOnce();
        });
        const dispose = order === "first" ? stopFirst : stopSecond;
        const remaining = order === "first" ? second : first;
        const removed = order === "first" ? first : second;
        dispose();
        dispose();
        expect(window.fetch).toBe(wrapper);
        await window.fetch("/api/x");
        await vi.waitFor(() => expect(remaining).toHaveBeenCalledTimes(2));
        expect(removed).toHaveBeenCalledOnce();
        stop();
        expect(window.fetch).toBe(fetch);
    });
});
