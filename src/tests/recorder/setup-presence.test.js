import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
    const listeners = {};
    const session = {};
    const event = (name) => ({
        addListener: (listener) => {
            listeners[name] = listener;
        },
    });
    const browser = {
        i18n: { getMessage: (key) => key },
        storage: {
            local: {
                get: async () => ({
                    dataUseAcknowledgedAt: "2026-10-20",
                    installationId: "installation-test",
                }),
                setAccessLevel: async () => {},
            },
            session: { get: async () => session },
            onChanged: event("storage"),
        },
        tabs: {
            get: async (id) => ({
                id,
                url:
                    id === 99
                        ? "chrome-extension://test/options/options.html"
                        : "https://klepna.example.com/settings?section=recorder",
            }),
            onUpdated: event("updated"),
            onRemoved: event("removed"),
        },
        windows: { onRemoved: event("window-removed") },
        runtime: {
            getURL: (path) => `chrome-extension://test/${path}`,
            getManifest: () => ({ version: "0.5.0" }),
            onMessage: event("internal"),
            onMessageExternal: event("external"),
            onInstalled: event("installed"),
            onStartup: event("startup"),
        },
        permissions: {
            contains: async () => true,
            onAdded: event("permission-added"),
            onRemoved: event("permission-removed"),
        },
        notifications: {
            onClicked: event("notification"),
            onButtonClicked: event("notification-button"),
        },
        alarms: { onAlarm: event("alarm") },
        action: { onClicked: event("action") },
        commands: { onCommand: event("command") },
    };
    globalThis.chrome = browser;
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { permissions: { query: async () => ({ state: "granted" }) } },
    });
    return { listeners, session };
});

import "../../../extensions/recorder/service-worker.js";

beforeEach(() => {
    h.session.recorderSetupFlow = {
        origin: "https://klepna.example.com",
        tabId: 7,
        surfaceTabId: 99,
        connected: true,
        createdAt: Date.now(),
    };
});

describe.each(["internal", "external"])("%s setup presence", (channel) => {
    it.each([
        ["https://klepna.example.com/settings", 7, true],
        ["https://klepna.example.com/settings", 8, false],
        ["https://other.example.com/settings", 7, false],
        ["https://klepna.example.com/settings", undefined, false],
    ])("restricts setupPending to %s tab %s", async (url, tabId, pending) => {
        const reply = await new Promise((resolve) =>
            h.listeners[channel](
                { type: "riffado-recorder-ping" },
                { url, ...(tabId !== undefined ? { tab: { id: tabId } } : {}) },
                resolve,
            ),
        );
        expect(reply.setupPending === true).toBe(pending);
    });
});
