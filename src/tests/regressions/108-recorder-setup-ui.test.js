import { afterAll, describe, expect, it, vi } from "vitest";
import {
    clearPairing,
    connectGrantedOrigins,
    connectOrigin,
    unregisterPairingScripts,
} from "../../../extensions/recorder/lib/pairing.js";
import { queuePairing } from "../../../extensions/recorder/lib/pairing-request.js";
import { effectivePlatformModes } from "../../../extensions/recorder/lib/settings.js";
import { prepareOriginSetup } from "../../../extensions/recorder/lib/setup.js";

const h = vi.hoisted(() => {
    const local = {};
    const session = {};
    const nodes = new Map();
    const handlers = {};
    const node = (id) => {
        if (!nodes.has(id))
            nodes.set(id, {
                testId: id,
                hidden: true,
                checked: false,
                value: "",
                textContent: "",
                className: "",
                children: [],
                scrollIntoView: vi.fn(),
                querySelector: (selector) => node(`${id}:${selector}`),
                querySelectorAll: () => [],
                addEventListener: (type, listener) => {
                    handlers[`${id}:${type}`] = listener;
                },
                append(...children) {
                    this.children.push(...children);
                },
                replaceChildren(...children) {
                    this.children = children;
                },
            });
        return nodes.get(id);
    };
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            permissions: { query: vi.fn(async () => ({ state: "prompt" })) },
            mediaDevices: {
                getUserMedia: vi.fn(async () => {
                    navigator.permissions.query.mockResolvedValue({
                        state: "granted",
                    });
                    return { getTracks: () => [{ stop: vi.fn() }] };
                }),
                enumerateDevices: vi.fn(async () => []),
            },
        },
    });
    globalThis.location = {
        search: "?origin=https%3A%2F%2Fexample.com&tabId=7",
    };
    globalThis.document = {
        documentElement: {},
        querySelectorAll: () => [],
        getElementById: node,
        createElement: () => ({
            ...node(`created-${Math.random()}`),
            dataset: {},
        }),
    };
    globalThis.window = {
        addEventListener: (event, handler) => {
            handlers[`window:${event}`] = handler;
        },
    };
    const area = (values) => ({
        get: vi.fn(async () => ({ ...values })),
        set: vi.fn(async (patch) => Object.assign(values, patch)),
        remove: vi.fn(async (keys) => {
            for (const key of [keys].flat()) delete values[key];
        }),
    });
    globalThis.chrome = {
        i18n: { getUILanguage: () => "en", getMessage: (key) => key },
        storage: {
            local: area(local),
            session: area(session),
            onChanged: { addListener: vi.fn() },
        },
        permissions: {
            request: vi.fn(async () => true),
            contains: vi.fn(async () => true),
        },
        scripting: {
            getRegisteredContentScripts: vi.fn(async () => []),
            unregisterContentScripts: vi.fn(async () => {}),
            registerContentScripts: vi.fn(async () => {}),
            updateContentScripts: vi.fn(async () => {}),
            executeScript: vi.fn(async () => {}),
        },
        tabs: {
            create: vi.fn(async () => ({ id: 10 })),
            getCurrent: vi.fn(async () => ({ id: 99 })),
            get: vi.fn(async (id) => ({
                id,
                windowId: 1,
                url:
                    id === 99
                        ? "chrome-extension://test/options/options.html?origin=https%3A%2F%2Fexample.com&tabId=7"
                        : "https://example.com/dashboard",
            })),
            query: vi.fn(async () => [
                { id: 7, url: "https://example.com/dashboard" },
                { id: 8, url: "https://other.example/" },
            ]),
            update: vi.fn(async () => {}),
        },
        windows: { update: vi.fn(async () => {}) },
        runtime: {
            id: "test",
            getURL: (path) => `chrome-extension://test/${path}`,
            sendMessage: vi.fn(async () => ({ ok: true })),
            openOptionsPage: vi.fn(async () => {}),
        },
        commands: { getAll: vi.fn(async () => []) },
    };
    return {
        local,
        session,
        node,
        handlers,
        storeToken: vi.fn(),
        confirmPairing: vi.fn(async () => ({})),
    };
});

vi.mock("../../../extensions/recorder/lib/chunk-store.js", () => ({
    listLocalSessions: vi.fn(async () => []),
    readLocalMeta: vi.fn(),
}));
vi.mock("../../../extensions/recorder/lib/token-vault.js", () => ({
    storeToken: vi.fn(async (key) => {
        h.storeToken(key);
        h.local.encryptedApiKey = { ciphertext: "test" };
    }),
    readToken: vi.fn(async () => "op_test"),
    clearToken: vi.fn(async () => {
        delete h.local.encryptedApiKey;
    }),
}));
vi.mock("../../../extensions/recorder/lib/api.js", () => ({
    confirmPairing: h.confirmPairing,
    getRecorderConfig: vi.fn(async () => ({ defaults: {} })),
}));
import "../../../extensions/recorder/options/options.js";

async function ensureConsented() {
    if (h.local.dataUseAcknowledgedAt) return;
    await vi.waitFor(() =>
        expect(h.node("setup-origin").textContent).toBe("setupConnectIntro"),
    );
    await h.handlers["accept-data-use:click"]();
}

describe("continuous recorder setup", () => {
    it("separates consent, microphone and site access, then accepts the selected key directly", async () => {
        expect(h.node("consent-body").hidden).toBe(false);
        expect(h.node("microphone-body").hidden).toBe(true);
        expect(h.node("recorder-settings").hidden).toBe(true);
        await h.handlers["accept-data-use:click"]();
        expect(h.local.dataUseAcknowledgedAt).toBeTypeOf("string");
        expect(chrome.permissions.request).not.toHaveBeenCalled();
        expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
        expect(h.node("consent-body").hidden).toBe(true);
        expect(h.node("microphone-body").hidden).toBe(false);
        await h.handlers["setup-grant-mic:click"]();
        expect(
            navigator.mediaDevices.getUserMedia,
        ).toHaveBeenCalledExactlyOnceWith({ audio: true });
        expect(chrome.permissions.request).not.toHaveBeenCalled();
        expect(h.node("connect-body").hidden).toBe(false);
        vi.useFakeTimers();
        try {
            const connect = h.handlers["setup-connect:click"]();
            expect(chrome.permissions.request).toHaveBeenCalledWith({
                origins: ["https://example.com/*"],
            });
            await connect;
            expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
                target: { tabId: 7 },
                files: ["content-pairing.js"],
            });
            await vi.advanceTimersByTimeAsync(5000);
            expect(h.node("setup-fallback").hidden).toBe(false);
            h.local.installationId = "installation-1";
            expect(
                await queuePairing(
                    { serverUrl: "https://example.com", apiKey: "op_test" },
                    "https://example.com",
                    chrome,
                    7,
                ),
            ).toEqual({ ok: true });
            expect(h.storeToken).toHaveBeenCalledWith("op_test");
            expect(h.session.pendingPairing).toBeUndefined();
            expect(h.session.recorderSetupFlow.completed).toBe(true);
            await h.handlers["window:focus"]();
            expect(h.node("setup-ready").hidden).toBe(false);
            expect(h.node("recorder-settings").hidden).toBe(false);
            await h.handlers["setup-return:click"]();
            expect(chrome.tabs.update).toHaveBeenCalledWith(7, {
                active: true,
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it("retains a skipped mic on recheck and offers settings for browser blocks", async () => {
        navigator.permissions.query.mockResolvedValue({ state: "denied" });
        await h.handlers["window:focus"]();
        expect(h.node("setup-grant-mic").hidden).toBe(true);
        expect(h.node("open-mic-settings").hidden).toBe(false);
        await h.handlers["open-mic-settings:click"]();
        expect(chrome.tabs.create).toHaveBeenCalledWith({
            url: "chrome://settings/content/microphone",
        });
        await h.handlers["skip-mic:click"]();
        expect(h.local.microphoneSetupSkipped).toBe(true);
        await h.handlers["window:focus"]();
        expect(h.node("setup-ready").hidden).toBe(false);
        expect(h.node("ready-grant-mic").hidden).toBe(false);
        await h.handlers["disconnect:click"]();
        expect(h.node("connect-body").hidden).toBe(false);
        expect(h.node("microphone-body").hidden).toBe(true);
        expect(h.node("step-microphone").className).toBe("step skipped");
    });

    it("rechecks microphone permissions on focus", async () => {
        navigator.permissions.query.mockResolvedValue({ state: "granted" });
        await h.handlers["window:focus"]();
        expect(h.node("step-microphone").className).toBe("step done");
    });

    it("keeps OS refusal visible even when the browser permission is granted", async () => {
        await h.handlers["ready-grant-mic:click"]();
        navigator.mediaDevices.getUserMedia.mockRejectedValueOnce({
            name: "NotAllowedError",
            message: "Permission denied by system",
        });
        await h.handlers["setup-grant-mic:click"]();
        expect(h.node("microphone-body").hidden).toBe(false);
        expect(h.node("setup-mic-status").textContent).toBe("micSystemOther");
        await h.handlers["window:focus"]();
        expect(h.node("microphone-body").hidden).toBe(false);
        await h.handlers["setup-grant-mic:click"]();
        expect(h.node("microphone-body").hidden).toBe(true);
    });

    it("manual save injects into open server tabs", async () => {
        await ensureConsented();
        h.node("server-url").value = "https://example.com";
        h.node("api-key").value = "op_manual";
        chrome.scripting.executeScript.mockClear();
        await h.handlers["save-connection:click"]();
        expect(h.storeToken).toHaveBeenCalledWith("op_manual");
        expect(chrome.scripting.executeScript).toHaveBeenCalledExactlyOnceWith({
            target: { tabId: 7 },
            files: ["content-pairing.js"],
        });
    });

    it("a Chrome-origin grant registers and injects without replacing other origin registrations", async () => {
        await ensureConsented();
        h.local.encryptedApiKey = { ciphertext: "test" };
        chrome.scripting.registerContentScripts.mockClear();
        chrome.scripting.executeScript.mockClear();
        await connectGrantedOrigins([
            "https://example.com/*",
            "https://other.example/*",
        ]);
        const scripts = chrome.scripting.registerContentScripts.mock.calls.map(
            ([scripts]) => scripts[0],
        );
        expect(scripts.map((script) => script.matches)).toEqual([
            ["https://example.com/*"],
        ]);
        expect(new Set(scripts.map((script) => script.id)).size).toBe(1);
        expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    });

    it("denied site access, missing consent, and a navigated setup tab prevent injection", async () => {
        await ensureConsented();
        chrome.scripting.executeScript.mockClear();
        chrome.permissions.request.mockResolvedValueOnce(false);
        await expect(
            prepareOriginSetup({ origin: "https://example.com", tabId: 7 }),
        ).rejects.toThrow();
        const consent = h.local.dataUseAcknowledgedAt;
        delete h.local.dataUseAcknowledgedAt;
        await expect(connectOrigin("https://example.com")).rejects.toThrow();
        h.local.dataUseAcknowledgedAt = consent;
        chrome.tabs.get.mockResolvedValueOnce({
            id: 7,
            url: "https://attacker.example",
        });
        await expect(
            prepareOriginSetup({ origin: "https://example.com", tabId: 7 }),
        ).rejects.toThrow();
        expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    });

    it("persists an explicit choice even when it matches the implicit prompt default", async () => {
        await ensureConsented();
        h.local.platformModes = {};
        const rows = h.node("platform-table:tbody").children;
        const select = rows
            .flatMap((row) => row.children[1]?.children ?? [])
            .findLast((node) => node.dataset?.platform === "google-meet");
        h.node("platform-table").querySelectorAll = () => [select];
        select.value = "off";
        h.handlers[`${select.testId}:change`]();
        select.value = "prompt";
        h.handlers[`${select.testId}:change`]();
        await h.handlers["save-all:click"]();
        expect(h.local.platformModes).toEqual({ "google-meet": "prompt" });
    });
});

describe("platform prompt defaults", () => {
    it("prompts only on Meet, Teams and Zoom for fresh and implicit-default users", () => {
        const modes = effectivePlatformModes({
            platformModes: {},
            serverDefaults: null,
        });
        expect(
            Object.entries(modes)
                .filter(([, entry]) => entry.mode === "prompt")
                .map(([id]) => id)
                .sort(),
        ).toEqual(["google-meet", "teams", "zoom"]);
        expect(modes.webex.mode).toBe("off");
        expect(modes.jitsi.mode).toBe("off");
    });
    it("keeps explicit user modes and server/locked precedence", () => {
        expect(
            effectivePlatformModes({
                platformModes: {
                    "google-meet": "off",
                    teams: "prompt",
                    zoom: "auto",
                },
                serverDefaults: {
                    autoRecordPlatforms: ["google-meet", "teams"],
                    lockDefaults: false,
                },
            }),
        ).toMatchObject({
            "google-meet": { mode: "off", source: "user" },
            teams: { mode: "prompt", source: "user" },
            zoom: { mode: "auto", source: "user" },
        });
        expect(
            effectivePlatformModes({
                platformModes: {},
                serverDefaults: { autoRecordPlatforms: ["google-meet"] },
            })["google-meet"],
        ).toEqual({ mode: "auto", source: "server" });
        expect(
            effectivePlatformModes({
                platformModes: { "google-meet": "off" },
                serverDefaults: {
                    autoRecordPlatforms: ["google-meet"],
                    lockDefaults: true,
                },
            })["google-meet"],
        ).toEqual({ mode: "auto", source: "locked" });
    });
});

describe("setup review boundaries", () => {
    it.each([
        ["https://foreign.example", 7],
        ["https://example.com", 8],
    ])("warns and refuses a proposal from %s tab %s in this setup", async (serverUrl, senderTabId) => {
        h.session.pendingPairing = {
            serverUrl,
            senderTabId,
            apiKey: "foreign-key",
        };
        chrome.storage.onChanged.addListener.mock.calls[0][0](
            { pendingPairing: {} },
            "session",
        );
        await vi.waitFor(() =>
            expect(h.node("pending-status").textContent).toBe(
                "setupProposalMismatch",
            ),
        );
        expect(h.node("confirm-pair").disabled).toBe(true);
        h.storeToken.mockClear();
        chrome.tabs.update.mockClear();
        chrome.permissions.request.mockClear();
        await h.handlers["confirm-pair:click"]();
        expect(h.storeToken).not.toHaveBeenCalled();
        expect(chrome.tabs.update).not.toHaveBeenCalled();
        expect(chrome.permissions.request).not.toHaveBeenCalled();
    });
    it("ignores wildcard grants and unrelated exact origins", async () => {
        chrome.scripting.registerContentScripts.mockClear();
        chrome.tabs.query.mockClear();
        await connectGrantedOrigins([
            "https://*/*",
            "https://*.example.com/*",
            "https://unrelated.example/*",
        ]);
        expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
        expect(chrome.tabs.query).not.toHaveBeenCalled();
    });
    it("permits only the live setup origin on a newly granted site", async () => {
        h.local.serverUrl = "https://paired.example";
        h.local.encryptedApiKey = {};
        h.session.recorderSetupFlow = {
            origin: "https://example.com",
            tabId: 7,
            createdAt: Date.now(),
        };
        chrome.scripting.registerContentScripts.mockClear();
        await connectGrantedOrigins([
            "https://example.com/*",
            "https://unrelated.example/*",
        ]);
        expect(
            chrome.scripting.registerContentScripts,
        ).toHaveBeenCalledExactlyOnceWith([
            expect.objectContaining({ matches: ["https://example.com/*"] }),
        ]);
    });
    it("removes broad and unrelated old relay registrations", async () => {
        chrome.scripting.getRegisteredContentScripts.mockResolvedValue([
            { id: "riffado-pairing-broad", matches: ["https://*/*"] },
            {
                id: "riffado-pairing-other",
                matches: ["https://unrelated.example/*"],
            },
            {
                id: "different-feature",
                matches: ["https://unrelated.example/*"],
            },
        ]);
        await unregisterPairingScripts();
        expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalledWith({
            ids: ["riffado-pairing-broad", "riffado-pairing-other"],
        });
    });
    it("re-enables dismissed reminders in Options", async () => {
        h.local.micReminderDismissed = true;
        h.node("mic-reminder").checked = true;
        await h.handlers["save-all:click"]();
        expect(h.local.micReminderDismissed).toBe(false);
    });
    it("unregisters relays and forgets the setup on disconnect", async () => {
        await clearPairing();
        expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalledWith({
            ids: ["riffado-pairing-broad", "riffado-pairing-other"],
        });
        expect(h.session.recorderSetupFlow).toBeUndefined();
        expect(h.session.pendingPairing).toBeUndefined();
        expect(h.local.serverUrl).toBeUndefined();
    });
});

afterAll(() => vi.useRealTimers());
