import { afterEach, describe, expect, it, vi } from "vitest";
import {
    refreshServerConfig,
    storePairing,
} from "../../../extensions/recorder/lib/pairing.js";

afterEach(() => vi.unstubAllGlobals());

describe("recorder data-use consent", () => {
    it("does not contact a paired server before the user agrees", async () => {
        const fetch = vi.fn();
        vi.stubGlobal("fetch", fetch);
        vi.stubGlobal("chrome", {
            i18n: { getMessage: () => "Chatterbox" },
            storage: {
                local: {
                    get: vi.fn(async () => ({
                        serverUrl: "https://example.com",
                        apiKey: "op_test",
                    })),
                    set: vi.fn(),
                },
            },
        });

        expect(await refreshServerConfig()).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe("pairing key storage guards", () => {
    it.each([
        false,
        true,
    ])("refuses key storage with consent=%s and no host access", async (consented) => {
        const set = vi.fn();
        vi.stubGlobal("chrome", {
            storage: {
                local: {
                    get: async () => ({
                        dataUseAcknowledgedAt: consented ? "2026-10-19" : null,
                    }),
                    set,
                },
            },
            permissions: { contains: vi.fn(async () => false) },
        });
        await expect(
            storePairing({
                serverUrl: "https://example.com",
                apiKey: "op_test",
            }),
        ).rejects.toThrow();
        expect(set).not.toHaveBeenCalled();
    });
});
