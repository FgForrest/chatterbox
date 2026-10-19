import { describe, expect, it, vi } from "vitest";
import { queuePairing } from "../../../extensions/recorder/lib/pairing-request.js";

function fakeBrowser() {
    return {
        storage: {
            session: {
                set: vi.fn(async () => {}),
                get: vi.fn(async () => ({})),
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
});
