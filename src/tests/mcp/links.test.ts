import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: { APP_URL: "https://riffado.example.com/" },
}));

import { recordingUrl } from "@/lib/mcp/links";

describe("recordingUrl", () => {
    it("opens an own recording on the dashboard", () => {
        expect(recordingUrl("rec 1", "private")).toBe(
            "https://riffado.example.com/dashboard?recording=rec+1",
        );
    });

    it("opens a shared recording in the Organization view", () => {
        expect(recordingUrl("rec-2", "org")).toBe(
            "https://riffado.example.com/dashboard?recording=rec-2&view=org",
        );
    });
});
