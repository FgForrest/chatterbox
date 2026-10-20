import { describe, expect, it, vi } from "vitest";
import { storePairing } from "../../../extensions/recorder/lib/pairing.js";
import { queuePairing } from "../../../extensions/recorder/lib/pairing-request.js";

vi.mock("../../../extensions/recorder/lib/pairing.js", () => ({
    originOf: (value) => {
        try {
            return new URL(value).origin;
        } catch {
            return null;
        }
    },
    storePairing: vi.fn(async () => {}),
}));

function fakeBrowser() {
    return {
        storage: {
            session: {
                set: vi.fn(async () => {}),
                get: vi.fn(async () => ({})),
                remove: vi.fn(async () => {}),
            },
            local: { set: vi.fn(async () => {}) },
        },
        runtime: { openOptionsPage: vi.fn(async () => {}) },
    };
}

describe("recorder pairing confirmation", () => {
    it("queues a matching origin without replacing the saved connection", async () => {
        const browser = fakeBrowser();
        const result = await queuePairing(
            { serverUrl: "https://example.com/path", apiKey: "op_test" },
            "https://example.com",
            browser,
        );

        expect(result).toEqual({ ok: true, pending: true });
        expect(browser.storage.session.set).toHaveBeenCalledWith({
            pendingPairing: {
                serverUrl: "https://example.com",
                apiKey: "op_test",
                senderTabId: null,
            },
        });
        expect(browser.runtime.openOptionsPage).toHaveBeenCalledOnce();
        expect(browser.storage.local.set).not.toHaveBeenCalled();
    });

    it("rejects a different origin before opening confirmation", async () => {
        const browser = fakeBrowser();
        await expect(
            queuePairing(
                { serverUrl: "https://attacker.example", apiKey: "op_test" },
                "https://example.com",
                browser,
            ),
        ).rejects.toThrow();
        expect(browser.storage.session.set).not.toHaveBeenCalled();
        expect(browser.runtime.openOptionsPage).not.toHaveBeenCalled();
    });
});

describe("pairing setup reuse boundaries", () => {
    it.each([
        "expired",
        "other-tab",
        "revoked",
        "closed-surface",
    ])("opens normal confirmation for %s setup", async (reason) => {
        const browser = fakeBrowser();
        browser.storage.session.get.mockResolvedValue({
            recorderSetupFlow: {
                origin: "https://example.com",
                tabId: reason === "other-tab" ? 8 : 7,
                surfaceTabId: 99,
                createdAt:
                    Date.now() - (reason === "expired" ? 16 * 60 * 1000 : 0),
                connected: true,
            },
        });
        browser.permissions = {
            contains: vi.fn(async () => reason !== "revoked"),
        };
        browser.tabs = { get: vi.fn(async () => null) };
        browser.runtime.getURL = (path) => `chrome-extension://test/${path}`;
        expect(
            await queuePairing(
                { serverUrl: "https://example.com", apiKey: "op_test" },
                "https://example.com",
                browser,
                7,
            ),
        ).toEqual({ ok: true, pending: true });
        expect(browser.runtime.openOptionsPage).toHaveBeenCalledOnce();
        expect(browser.storage.local.set).not.toHaveBeenCalled();
    });

    it("stores a matching setup key directly and returns to its options tab", async () => {
        const browser = fakeBrowser();
        const flow = {
            origin: "https://klepna.example.com",
            tabId: 7,
            surfaceTabId: 99,
            createdAt: Date.now(),
            connected: true,
        };
        browser.storage.session.get.mockResolvedValue({
            recorderSetupFlow: flow,
        });
        browser.permissions = { contains: vi.fn(async () => true) };
        browser.runtime.getURL = (path) => `chrome-extension://test/${path}`;
        browser.tabs = {
            get: vi.fn(async () => ({
                id: 99,
                windowId: 1,
                url: "chrome-extension://test/options/options.html",
            })),
            update: vi.fn(async () => {}),
        };
        browser.windows = { update: vi.fn(async () => {}) };
        expect(
            await queuePairing(
                { serverUrl: flow.origin, apiKey: "op_test" },
                flow.origin,
                browser,
                7,
            ),
        ).toEqual({ ok: true });
        expect(storePairing).toHaveBeenCalledWith({
            serverUrl: flow.origin,
            apiKey: "op_test",
        });
        expect(browser.storage.session.set).toHaveBeenCalledWith({
            recorderSetupFlow: { ...flow, completed: true },
        });
        expect(browser.storage.session.remove).toHaveBeenCalledWith(
            "pendingPairing",
        );
        expect(browser.tabs.update).toHaveBeenCalledWith(99, { active: true });
        expect(browser.runtime.openOptionsPage).not.toHaveBeenCalled();
    });
});
