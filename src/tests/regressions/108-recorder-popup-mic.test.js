import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
    const nodes = new Map();
    const handlers = {};
    let onMessage;
    const local = {
        dataUseAcknowledgedAt: "2026-10-19",
        serverUrl: "https://example.com",
        encryptedApiKey: {},
    };
    const node = (id) => {
        if (!nodes.has(id))
            nodes.set(id, {
                hidden: true,
                textContent: "",
                children: [],
                value: "",
                style: {},
                setAttribute: vi.fn(),
                addEventListener: (event, listener) => {
                    handlers[`${id}:${event}`] = listener;
                },
                replaceChildren(...children) {
                    this.children = children;
                },
            });
        return nodes.get(id);
    };
    globalThis.document = {
        documentElement: {},
        querySelectorAll: () => [],
        getElementById: node,
        createElement: () => ({
            setAttribute: vi.fn(),
            addEventListener: vi.fn(),
        }),
    };
    globalThis.window = { close: vi.fn() };
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            permissions: { query: vi.fn(async () => ({ state: "prompt" })) },
        },
    });
    globalThis.chrome = {
        i18n: { getMessage: (key) => key, getUILanguage: () => "en" },
        storage: {
            local: {
                get: vi.fn(async () => ({ ...local })),
                set: vi.fn(async (patch) => Object.assign(local, patch)),
            },
            session: { remove: vi.fn(async () => {}) },
        },
        runtime: {
            getURL: (path) => `chrome-extension://test/${path}`,
            sendMessage: vi.fn(async (message) =>
                message.type === "get-state"
                    ? { state: { state: "idle" } }
                    : { ok: true },
            ),
            onMessage: {
                addListener: (listener) => {
                    onMessage = listener;
                },
            },
        },
        tabs: {
            query: vi.fn(async () => [{ id: 7, url: "https://example.com" }]),
            create: vi.fn(async () => {}),
        },
    };
    return {
        node,
        handlers,
        local,
        state: (state) => onMessage({ type: "state", state }),
    };
});

import "../../../extensions/recorder/popup/popup.js";

describe("popup microphone warning", () => {
    it("shows missing permission with an Allow action", async () => {
        await vi.waitFor(() => expect(h.node("view-idle").hidden).toBe(false));
        expect(h.node("mic-warning").hidden).toBe(false);
        expect(h.node("mic-warning-text").textContent).toBe("micWarning");
        await h.handlers["allow-mic:click"]();
        expect(chrome.tabs.create).toHaveBeenCalledWith({
            url: "chrome-extension://test/options/options.html?microphone=1",
        });
    });
    it("lets a deliberate mic-less recorder persistently dismiss reminders", async () => {
        h.state({ state: "idle", withoutMicrophone: true });
        await vi.waitFor(() =>
            expect(h.node("dismiss-mic").hidden).toBe(false),
        );
        await h.handlers["dismiss-mic:click"]();
        expect(h.local.micReminderDismissed).toBe(true);
        expect(h.node("mic-warning").hidden).toBe(true);
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "reevaluate-tabs",
        });
    });
    it("shows device failures even with granted permission and dismissed reminders", async () => {
        navigator.permissions.query.mockResolvedValue({ state: "granted" });
        h.local.micReminderDismissed = true;
        h.state({
            state: "idle",
            micWarning:
                "Only meeting audio is being recorded. The microphone is busy.",
        });
        await vi.waitFor(() =>
            expect(h.node("mic-warning").hidden).toBe(false),
        );
        expect(h.node("mic-warning-text").textContent).toContain(
            "microphone is busy",
        );
        expect(h.node("dismiss-mic").hidden).toBe(true);
    });
    it("does not show a mic warning before data-use consent", async () => {
        h.local.dataUseAcknowledgedAt = null;
        navigator.permissions.query.mockResolvedValue({ state: "prompt" });
        h.state({ state: "idle" });
        await vi.waitFor(() => expect(h.node("mic-warning").hidden).toBe(true));
    });
});
