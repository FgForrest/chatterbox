import { describe, expect, it, vi } from "vitest";

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
                        input: { tabId: 7 },
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

describe("visible microphone and participant request", () => {
    it("requires the participant acknowledgement then resumes automatically after the mic grant", async () => {
        await vi.waitFor(() =>
            expect(h.node("mic-status").textContent).toBe("micWarning"),
        );
        await h.handlers["grant-mic:click"]();
        expect(h.node("mic-status").textContent).toBe("participantAckRequired");
        expect(h.getUserMedia).not.toHaveBeenCalled();
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
        h.node("notice-check").checked = true;
        await h.handlers["grant-mic:click"]();
        expect(h.getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true });
        expect(chrome.storage.session.set).toHaveBeenCalledWith({
            microphoneGrantAt: expect.any(Number),
        });
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "resume-recording",
            requestId: "request-1",
            withoutMicrophone: false,
            noticeAcknowledgedAt: expect.any(String),
        });
        expect(window.close).toHaveBeenCalledOnce();
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "reevaluate-tabs",
        });
        expect(h.node("meeting-title").textContent).toBe(
            "Google Meet · meet.google.com · abc-defg-hij",
        );
    });

    it("offers explicit recording without mic even when Chrome blocks access", async () => {
        h.node("notice-check").checked = true;
        h.setState("denied");
        chrome.runtime.sendMessage.mockClear();
        await h.handlers["window:focus"]();
        expect(h.node("grant-mic").hidden).toBe(true);
        expect(h.node("start").hidden).toBe(true);
        expect(h.node("mic-status").textContent).toContain("micReallow");
        await h.handlers["without-mic:click"]();
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ withoutMicrophone: true }),
        );
    });
});
