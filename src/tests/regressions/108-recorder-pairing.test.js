import { describe, expect, it, vi } from "vitest";
import { queuePairing } from "../../../extensions/recorder/lib/pairing-request.js";

function fakeBrowser() {
    return {
        storage: {
            session: { set: vi.fn(async () => {}) },
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
