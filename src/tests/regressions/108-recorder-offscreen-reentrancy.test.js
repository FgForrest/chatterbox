import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    let onMessage;
    globalThis.chrome = {
        runtime: {
            onMessage: {
                addListener: (listener) => {
                    onMessage = listener;
                },
            },
            sendMessage: vi.fn(async () => {}),
        },
    };
    return {
        message: (...args) => onMessage(...args),
        importCaptureKey: vi.fn(),
    };
});

vi.mock("../../../extensions/recorder/lib/chunk-crypto.js", () => ({
    importCaptureKey: harness.importCaptureKey,
    encryptChunk: vi.fn(),
}));
vi.mock("../../../extensions/recorder/lib/chunk-store.js", () => ({
    writeChunk: vi.fn(),
}));

import "../../../extensions/recorder/offscreen/offscreen.js";

describe("offscreen capture setup", () => {
    it("rejects a second start while the first is still opening", async () => {
        let rejectFirst;
        harness.importCaptureKey.mockImplementationOnce(
            () =>
                new Promise((_, reject) => {
                    rejectFirst = reject;
                }),
        );
        const payload = { sessionId: "session-1", captureKey: "key" };
        const first = new Promise((resolve) => {
            harness.message(
                { target: "offscreen", type: "start", payload },
                {},
                resolve,
            );
        });
        await vi.waitFor(() =>
            expect(harness.importCaptureKey).toHaveBeenCalledTimes(1),
        );
        const second = await new Promise((resolve) => {
            harness.message(
                { target: "offscreen", type: "start", payload },
                {},
                resolve,
            );
        });

        expect(second).toEqual({
            ok: false,
            error: "A recording is already in progress",
        });
        expect(harness.importCaptureKey).toHaveBeenCalledTimes(1);
        rejectFirst(new Error("Key import failed"));
        expect(await first).toEqual({ ok: false, error: "Key import failed" });

        harness.importCaptureKey.mockRejectedValueOnce(
            new Error("Next attempt"),
        );
        const third = await new Promise((resolve) => {
            harness.message(
                { target: "offscreen", type: "start", payload },
                {},
                resolve,
            );
        });
        expect(third).toEqual({ ok: false, error: "Next attempt" });
    });
});
