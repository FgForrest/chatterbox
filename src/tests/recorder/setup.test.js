import { afterEach, describe, expect, it, vi } from "vitest";
import {
    findRecorderSetupTabs,
    normalizeSetupAddress,
    prepareOriginSetup,
} from "../../../extensions/recorder/lib/setup.js";
import {
    activeSetupFlow,
    resumeTypedSetupAfterLogin,
} from "../../../extensions/recorder/lib/setup-flow.js";
import {
    microphonePromptCopy,
    setupBrowserInfo,
    setupMicrophoneFailure,
} from "../../../extensions/recorder/lib/setup-microphone.js";

afterEach(() => vi.unstubAllGlobals());

describe("recorder address discovery", () => {
    it.each([
        ["klepna.example.com", "https://klepna.example.com"],
        [
            " https://klepna.example.com/settings?section=recorder ",
            "https://klepna.example.com",
        ],
        ["klepna.example.com:8443/path", "https://klepna.example.com:8443"],
        ["http://localhost:3000", "http://localhost:3000"],
        ["http://klepna.example.com", null],
        ["https://user:password@klepna.example.com", null],
        ["https://*.example.com", null],
        ["javascript:alert(1)", null],
        ["https://", null],
        ["klepna.example.com bad", null],
        ["", null],
    ])("normalizes %s", (address, expected) => {
        expect(normalizeSetupAddress(address)).toBe(expected);
    });

    it("finds one or several marked tabs, including onboarding", () => {
        const first = {
            id: 1,
            title: "Settings",
            url: "https://klepna.example.com/settings?section=recorder",
        };
        const second = {
            id: 2,
            title: "Setup",
            url: "https://other.example.com/onboarding?section=recorder",
        };
        const invalid = [
            { id: 3, url: "https://klepna.example.com/settings#recorder" },
            {
                id: 4,
                url: "https://klepna.example.com/settings?section=providers",
            },
            { id: 5, url: "chrome://settings?section=recorder" },
            {
                id: 6,
                url: "http://remote.example.com/settings?section=recorder",
            },
            { id: 7 },
        ];
        expect(findRecorderSetupTabs(invalid)).toEqual([]);
        expect(findRecorderSetupTabs([first, ...invalid])).toEqual([
            {
                origin: "https://klepna.example.com",
                tabId: 1,
                title: "Settings",
            },
        ]);
        expect(findRecorderSetupTabs([first, second, ...invalid])).toHaveLength(
            2,
        );
    });

    it("requests access before opening a typed server and records its new tab", async () => {
        const session = {};
        vi.stubGlobal("chrome", {
            permissions: {
                request: vi.fn(async () => true),
                contains: async () => true,
            },
            tabs: {
                create: vi.fn(async () => ({ id: 7 })),
                getCurrent: async () => ({ id: 99 }),
                get: async () => ({
                    id: 7,
                    url: "about:blank",
                    pendingUrl:
                        "https://klepna.example.com/settings?section=recorder",
                }),
                query: async () => [],
            },
            storage: {
                local: {
                    get: async () => ({ dataUseAcknowledgedAt: "2026-10-20" }),
                },
                session: {
                    set: async (patch) => Object.assign(session, patch),
                },
            },
            scripting: { registerContentScripts: vi.fn(async () => {}) },
        });
        const prepared = prepareOriginSetup({
            origin: "https://klepna.example.com",
            typed: true,
        });
        expect(chrome.permissions.request).toHaveBeenCalledOnce();
        expect(chrome.tabs.create).not.toHaveBeenCalled();
        expect(await prepared).toEqual({
            origin: "https://klepna.example.com",
            tabId: 7,
            typed: true,
        });
        expect(chrome.tabs.create).toHaveBeenCalledWith({
            url: "https://klepna.example.com/settings?section=recorder",
            active: false,
        });
        expect(session.recorderSetupFlow).toMatchObject({
            tabId: 7,
            surfaceTabId: 99,
            connected: true,
            typed: true,
        });
    });
});

describe("pending setup presence boundary", () => {
    it("resumes only the chosen typed tab once after login", async () => {
        const session = {
            recorderSetupFlow: {
                origin: "https://klepna.example.com",
                tabId: 7,
                surfaceTabId: 99,
                connected: true,
                typed: true,
                createdAt: Date.now(),
            },
        };
        const browser = {
            storage: {
                session: {
                    get: async () => session,
                    set: async (patch) => Object.assign(session, patch),
                },
            },
            permissions: { contains: async () => true },
            tabs: {
                get: async () => ({
                    url: "chrome-extension://test/options/options.html",
                }),
                update: vi.fn(async () => {}),
            },
            runtime: { getURL: (path) => `chrome-extension://test/${path}` },
        };
        expect(
            await resumeTypedSetupAfterLogin(
                { id: 7, url: "https://klepna.example.com/dashboard" },
                browser,
            ),
        ).toBe(false);
        await resumeTypedSetupAfterLogin(
            { id: 7, url: "https://klepna.example.com/login" },
            browser,
        );
        expect(
            await resumeTypedSetupAfterLogin(
                { id: 8, url: "https://klepna.example.com/dashboard" },
                browser,
            ),
        ).toBe(false);
        expect(
            await resumeTypedSetupAfterLogin(
                { id: 7, url: "https://other.example.com/dashboard" },
                browser,
            ),
        ).toBe(false);
        expect(
            await resumeTypedSetupAfterLogin(
                { id: 7, url: "https://klepna.example.com/dashboard" },
                browser,
            ),
        ).toBe(true);
        expect(browser.tabs.update).toHaveBeenCalledExactlyOnceWith(7, {
            url: "https://klepna.example.com/settings?section=recorder",
        });
        expect(
            await resumeTypedSetupAfterLogin(
                { id: 7, url: "https://klepna.example.com/dashboard" },
                browser,
            ),
        ).toBe(false);
    });
    it.each([
        "matching",
        "foreign-origin",
        "foreign-tab",
        "missing-tab",
        "expired",
        "future",
        "not-connected",
        "completed",
        "revoked",
        "closed-surface",
    ])("matches only an active authorized flow: %s", async (reason) => {
        const flow = {
            origin: "https://klepna.example.com",
            tabId: 7,
            surfaceTabId: 99,
            createdAt: Date.now(),
            connected: true,
            completed: false,
        };
        if (reason === "expired") flow.createdAt -= 15 * 60 * 1000;
        if (reason === "future") flow.createdAt += 60000;
        if (reason === "not-connected") flow.connected = false;
        if (reason === "completed") flow.completed = true;
        const browser = {
            storage: {
                session: { get: async () => ({ recorderSetupFlow: flow }) },
            },
            permissions: { contains: async () => reason !== "revoked" },
            tabs: {
                get: async () =>
                    reason === "closed-surface"
                        ? null
                        : {
                              url: "chrome-extension://test/options/options.html",
                          },
            },
            runtime: { getURL: (path) => `chrome-extension://test/${path}` },
        };
        const result = await activeSetupFlow(
            reason === "foreign-origin"
                ? "https://other.example.com"
                : flow.origin,
            reason === "missing-tab"
                ? undefined
                : reason === "foreign-tab"
                  ? 8
                  : 7,
            browser,
        );
        expect(Boolean(result)).toBe(reason === "matching");
    });
});

describe("microphone browser and OS guidance", () => {
    it.each([
        [
            {
                userAgentData: {
                    brands: [{ brand: "Brave" }],
                    platform: "macOS",
                },
            },
            "brave",
            "mac",
        ],
        [
            {
                userAgentData: {
                    brands: [{ brand: "Microsoft Edge" }],
                    platform: "Windows",
                },
            },
            "edge",
            "windows",
        ],
        [
            {
                userAgentData: {
                    brands: [{ brand: "Google Chrome" }],
                    platform: "Linux",
                },
            },
            "chrome",
            "other",
        ],
        [{ userAgent: "Chrome/140 Edg/140 Windows NT" }, "edge", "windows"],
        [{ userAgent: "Brave/140 Macintosh" }, "brave", "mac"],
        [{ userAgent: "Chrome/140 Macintosh" }, "chrome", "mac"],
        [{ userAgent: "Chromium/140 Linux" }, "chromium", "other"],
    ])("detects browser and platform", (nav, browser, platform) => {
        expect(setupBrowserInfo(nav)).toMatchObject({ browser, platform });
    });

    it("uses exact labels only for Chrome", () => {
        vi.stubGlobal("chrome", { i18n: { getMessage: (key) => key } });
        expect(microphonePromptCopy({ browser: "chrome" }).permanent).toBe(
            "micAllowPermanent",
        );
        for (const browser of ["edge", "brave", "chromium"]) {
            expect(microphonePromptCopy({ browser }).permanent).toBe(
                "micPermanentNeutral",
            );
        }
    });

    it.each([
        ["mac", "micSystemMac"],
        ["windows", "micSystemWindows"],
        ["other", "micSystemOther"],
    ])("explains OS refusal on %s", (platform, key) => {
        vi.stubGlobal("chrome", { i18n: { getMessage: (key) => key } });
        expect(
            setupMicrophoneFailure(
                {
                    name: "NotAllowedError",
                    message: "Permission denied by system",
                },
                { platform, name: "Google Chrome" },
            ),
        ).toBe(key);
        expect(
            setupMicrophoneFailure(
                { name: "NotAllowedError", message: "Permission denied" },
                { platform },
            ),
        ).toBeNull();
        expect(
            setupMicrophoneFailure(
                { name: "NotAllowedError", message: "Disabled by policy" },
                { platform },
            ),
        ).toBe("micManaged");
    });
});
