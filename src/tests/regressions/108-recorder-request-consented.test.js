import { describe, expect, it, vi } from "vitest";

vi.mock("../../../extensions/recorder/lib/fit-window.js", () => ({
    fitWindowToContent: () => {},
}));

const h = vi.hoisted(() => {
    const handlers = {};
    const nodes = new Map();
    const node = (id) => {
        if (!nodes.has(id))
            nodes.set(id, {
                hidden: true,
                checked: false,
                textContent: "",
                addEventListener: (event, listener) => {
                    handlers[`${id}:${event}`] = listener;
                },
            });
        return nodes.get(id);
    };
    let state = "prompt";
    const getUserMedia = vi.fn(async () => {
        state = "granted";
        return { getTracks: () => [{ stop: vi.fn() }] };
    });
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            permissions: { query: vi.fn(async () => ({ state })) },
            mediaDevices: { getUserMedia },
        },
    });
    globalThis.document = {
        documentElement: {},
        querySelectorAll: () => [],
        getElementById: node,
    };
    globalThis.location = {
        href: "chrome-extension://test/request/request.html?requestId=request-1",
    };
    globalThis.window = {
        close: vi.fn(),
        addEventListener: (event, listener) => {
            handlers[`window:${event}`] = listener;
        },
    };
    globalThis.chrome = {
        i18n: { getUILanguage: () => "en", getMessage: (key) => key },
        storage: {
            session: {
                set: vi.fn(async () => {}),
                remove: vi.fn(async () => {}),
                get: vi.fn(async () => ({
                    recorderStartRequest: {
                        id: "request-1",
                        createdAt: Date.now(),
                        input: {
                            tabId: 7,
                            noticeAcknowledgedAt: "2026-10-20T08:00:00.000Z",
                        },
                        tabUrl: "https://meet.google.com/abc-defg-hij",
                    },
                })),
            },
            local: { get: vi.fn(async () => ({})) },
        },
        runtime: { id: "test", sendMessage: vi.fn(async () => ({ ok: true })) },
    };
    return {
        node,
        handlers,
        getUserMedia,
        setState: (value) => {
            state = value;
        },
    };
});

import "../../../extensions/recorder/request/request.js";

describe("microphone request after the popup's or notification's consent", () => {
    it("shows no consent wording and records right after the mic grant", async () => {
        await vi.waitFor(() =>
            expect(h.node("mic-status").textContent).toBe("micWarning"),
        );
        expect(h.node("notice-text").hidden).toBe(true);
        expect(h.node("start").textContent).toBe("record");
        expect(h.node("without-mic").textContent).toBe("recordWithoutMic");
        await h.handlers["grant-mic:click"]();
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "resume-recording",
            requestId: "request-1",
            withoutMicrophone: false,
            noticeAcknowledgedAt: "2026-10-20T08:00:00.000Z",
        });
        expect(window.close).toHaveBeenCalledOnce();
    });
});
