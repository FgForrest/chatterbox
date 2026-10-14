import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadChunk } from "../../../extensions/recorder/lib/api.js";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("recorder API errors", () => {
    it("carry the server's error code next to its message and status", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            Response.json(
                {
                    error: "The key's holder no longer has access to this application",
                    code: "ACCESS_NOT_GRANTED",
                },
                { status: 403 },
            ),
        );
        await expect(
            uploadChunk(
                { serverUrl: "https://chatterbox.example", apiKey: "op_x" },
                "session-1",
                0,
                new Blob(["x"]),
                "0".repeat(64),
            ),
        ).rejects.toMatchObject({
            status: 403,
            code: "ACCESS_NOT_GRANTED",
            message:
                "The key's holder no longer has access to this application",
        });
    });

    it("has no code for a body without one", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response("busy", { status: 503 }),
        );
        await expect(
            uploadChunk(
                { serverUrl: "https://chatterbox.example", apiKey: "op_x" },
                "session-1",
                0,
                new Blob(["x"]),
                "0".repeat(64),
            ),
        ).rejects.toMatchObject({ status: 503, code: null });
    });
});
