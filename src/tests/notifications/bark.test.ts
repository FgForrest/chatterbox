import { afterEach, describe, expect, it, vi } from "vitest";
import { sendBarkNotification } from "@/lib/notifications/bark";

vi.mock("@/lib/env", () => ({ env: {} }));

describe("Bark notifications", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("rejects non-http(s) push URLs before fetch", async () => {
        const fetch = vi.fn();
        vi.stubGlobal("fetch", fetch);
        vi.spyOn(console, "error").mockImplementation(() => {});

        await expect(
            sendBarkNotification("file:", { body: "Example" }),
        ).resolves.toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });

    it("passes a configured URL with credentials to the transport", async () => {
        const fetch = vi.fn().mockResolvedValue(new Response("ok"));
        vi.stubGlobal("fetch", fetch);
        const url = "https://user:secret@bark.example.com/push";

        await expect(
            sendBarkNotification(url, { body: "Example" }),
        ).resolves.toBe(true);
        expect(fetch).toHaveBeenCalledWith(url, expect.anything());
    });
});
