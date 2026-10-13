import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

function setupPicker(chooseDesktopMedia) {
    const nodes = new Map();
    const node = (id) => {
        if (!nodes.has(id)) {
            nodes.set(id, {
                textContent: "",
                hidden: false,
                disabled: false,
                style: {},
                classList: { add: vi.fn() },
                addEventListener: vi.fn(),
            });
        }
        return nodes.get(id);
    };
    const events = [];
    const stream = {
        getAudioTracks: () => [{}],
        getVideoTracks: () => [{ stop: vi.fn() }],
        getTracks: () => [{ stop: vi.fn() }],
    };
    const getUserMedia = vi.fn(async () => {
        events.push("opened-in-picker-frame");
        return stream;
    });
    const sendMessage = vi.fn(async (message) => {
        events.push(message.type);
        return { ok: true };
    });

    vi.stubGlobal("location", {
        href: "chrome-extension://test/picker/picker.html?requestId=request-1",
    });
    vi.stubGlobal("document", {
        documentElement: { lang: "" },
        title: "",
        getElementById: node,
        querySelectorAll: () => [],
    });
    vi.stubGlobal("window", { close: vi.fn() });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("chrome", {
        i18n: { getUILanguage: () => "en", getMessage: (key) => key },
        runtime: {
            sendMessage,
            onMessage: { addListener: vi.fn() },
        },
        desktopCapture: { chooseDesktopMedia },
    });

    return { node, events, getUserMedia, sendMessage, stream };
}

describe("desktop recorder extension window", () => {
    it("consumes the stream ID in the picker frame before starting the server session", async () => {
        const chooseDesktopMedia = vi.fn((_sources, callback) => {
            callback("desktop-stream", { canRequestAudioTrack: true });
            return 123;
        });
        const { events, getUserMedia, sendMessage } =
            setupPicker(chooseDesktopMedia);

        await import("../../../extensions/recorder/picker/picker.js");
        await vi.waitFor(() =>
            expect(sendMessage).toHaveBeenCalledWith({
                type: "desktop-capture-ready",
                requestId: "request-1",
                error: undefined,
            }),
        );

        expect(chooseDesktopMedia).toHaveBeenCalledWith(
            ["tab", "screen", "audio"],
            expect.any(Function),
        );
        expect(getUserMedia).toHaveBeenCalledWith({
            audio: {
                mandatory: {
                    chromeMediaSource: "desktop",
                    chromeMediaSourceId: "desktop-stream",
                },
            },
            video: {
                mandatory: {
                    chromeMediaSource: "desktop",
                    chromeMediaSourceId: "desktop-stream",
                },
            },
        });
        expect(events).toEqual([
            "opened-in-picker-frame",
            "desktop-capture-ready",
        ]);
        expect(sendMessage.mock.calls.flat()).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ streamId: "desktop-stream" }),
            ]),
        );
    });

    it("reports capture API failure without creating a server session", async () => {
        const chooseDesktopMedia = vi.fn(() => {
            throw new Error("Picker unavailable");
        });
        const { node, sendMessage } = setupPicker(chooseDesktopMedia);

        await import("../../../extensions/recorder/picker/picker.js");
        await vi.waitFor(() =>
            expect(sendMessage).toHaveBeenCalledWith({
                type: "desktop-picker-error",
                requestId: "request-1",
                error: "Picker unavailable",
            }),
        );

        expect(node("picker-status").textContent).toBe("Picker unavailable");
    });
});
