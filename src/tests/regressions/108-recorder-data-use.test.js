import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshServerConfig } from "../../../extensions/recorder/lib/pairing.js";

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
