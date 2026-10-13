import { describe, expect, it } from "vitest";
import { canPumpUploads } from "../../../extensions/recorder/lib/upload-state.js";

describe("recorder upload retry", () => {
    it("reenters the upload pump after finalization failed", () => {
        expect(
            canPumpUploads({
                sessionId: "recording-1",
                state: "error",
                stopped: true,
            }),
        ).toBe(true);
    });

    it("does not retry a capture error with no completed recording", () => {
        expect(
            canPumpUploads({
                sessionId: "recording-1",
                state: "error",
                stopped: false,
            }),
        ).toBe(false);
    });
});
