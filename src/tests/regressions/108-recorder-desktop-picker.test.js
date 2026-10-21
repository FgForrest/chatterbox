import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaptureHost } from "../../../extensions/recorder/lib/capture-host.js";

const { fitWindowToContent } = vi.hoisted(() => ({
    fitWindowToContent: vi.fn(),
}));

vi.mock("../../../extensions/recorder/lib/fit-window.js", () => ({
    fitWindowToContent,
}));

beforeEach(() => {
    vi.resetModules();
    fitWindowToContent.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

function setupPicker(chooseDesktopMedia) {
    const nodes = new Map();
    let onMessage;
    const node = (id) => {
        if (!nodes.has(id)) {
            nodes.set(id, {
                textContent: "",
                hidden: false,
                disabled: false,
                style: {},
                attributes: new Map(),
                setAttribute(name, value) {
                    this.attributes.set(name, value);
                },
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
    const windows = {
        getCurrent: vi.fn(async () => ({ id: 7, state: "normal" })),
        update: vi.fn(async () => {
            events.push("window-narrowed");
            return {};
        }),
    };
    fitWindowToContent.mockImplementation(() => events.push("window-fitted"));

    vi.stubGlobal("location", {
        href: "chrome-extension://test/picker/picker.html?requestId=request-1",
    });
    vi.stubGlobal("document", {
        documentElement: { lang: "" },
        title: "",
        getElementById: node,
        querySelectorAll: () => [],
    });
    const close = vi.fn();
    vi.stubGlobal("window", { close });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("chrome", {
        i18n: { getUILanguage: () => "en", getMessage: (key) => key },
        runtime: {
            sendMessage,
            onMessage: {
                addListener: (listener) => {
                    onMessage = listener;
                },
            },
        },
        desktopCapture: { chooseDesktopMedia },
        windows,
    });

    return {
        node,
        events,
        windows,
        getUserMedia,
        sendMessage,
        stream,
        close,
        dispatchState: (state) =>
            onMessage({
                type: "state",
                state: { pickerRequestId: "request-1", ...state },
            }),
    };
}

describe("desktop recorder extension window", () => {
    it("rejects a desktop start without a stream opened in the picker frame", async () => {
        const getUserMedia = vi.fn();
        vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

        await expect(
            createCaptureHost().start({ captureMode: "desktop" }),
        ).rejects.toThrow("Desktop audio must be opened in the picker window");
        expect(getUserMedia).not.toHaveBeenCalled();
    });

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
            "window-narrowed",
            "window-fitted",
            "desktop-capture-ready",
        ]);
        expect(sendMessage.mock.calls.flat()).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ streamId: "desktop-stream" }),
            ]),
        );
    });

    it("leaves the window at full size while Chrome's dialog is open", async () => {
        let choose;
        const chooseDesktopMedia = vi.fn((_sources, callback) => {
            choose = callback;
            return 123;
        });
        const { windows, sendMessage } = setupPicker(chooseDesktopMedia);

        await import("../../../extensions/recorder/picker/picker.js");
        await vi.waitFor(() => expect(chooseDesktopMedia).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(windows.update).not.toHaveBeenCalled();
        expect(fitWindowToContent).not.toHaveBeenCalled();

        choose("desktop-stream", { canRequestAudioTrack: true });
        await vi.waitFor(() =>
            expect(sendMessage).toHaveBeenCalledWith(
                expect.objectContaining({ type: "desktop-capture-ready" }),
            ),
        );
        expect(windows.update).toHaveBeenCalledExactlyOnceWith(7, {
            width: 430,
        });
        expect(fitWindowToContent).toHaveBeenCalledOnce();
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

        await vi.waitFor(() =>
            expect(node("picker-status").textContent).toBe(
                "Picker unavailable",
            ),
        );
        await vi.waitFor(() =>
            expect(fitWindowToContent).toHaveBeenCalledOnce(),
        );
    });

    it("keeps the recorder window visible through upload, server save, and confirmation", async () => {
        const chooseDesktopMedia = vi.fn((_sources, callback) => {
            callback("desktop-stream", { canRequestAudioTrack: true });
            return 123;
        });
        const { node, sendMessage, close, dispatchState } =
            setupPicker(chooseDesktopMedia);
        await import("../../../extensions/recorder/picker/picker.js");
        await vi.waitFor(() =>
            expect(sendMessage).toHaveBeenCalledWith(
                expect.objectContaining({ type: "desktop-capture-ready" }),
            ),
        );

        dispatchState({
            state: "recording",
            stopped: true,
            chunkCount: 4,
            uploaded: [0, 1],
        });
        expect(node("picker-progress").hidden).toBe(false);
        expect(node("picker-controls").hidden).toBe(true);
        expect(node("picker-upload-progress-fill").style.width).toBe("50%");
        expect(
            node("picker-upload-progress").attributes.get("aria-valuenow"),
        ).toBe("50");
        expect(node("picker-processing").hidden).toBe(true);
        expect(close).not.toHaveBeenCalled();

        dispatchState({
            state: "finalizing",
            stopped: true,
            chunkCount: 4,
            uploaded: [0, 1, 2, 3],
        });
        expect(node("picker-progress-stage").textContent).toBe(
            "processingRecording",
        );
        expect(node("picker-processing").hidden).toBe(false);
        expect(node("picker-processing-status").textContent).toBe(
            "uploadComplete",
        );
        expect(node("picker-completed").hidden).toBe(true);
        expect(close).not.toHaveBeenCalled();

        dispatchState({ state: "completed", partial: false });
        expect(node("picker-progress").hidden).toBe(true);
        expect(node("picker-completed").hidden).toBe(false);
        expect(node("picker-completion-check").hidden).toBe(false);
        expect(node("picker-completion-message").textContent).toBe(
            "recordingStored",
        );
        expect(close).not.toHaveBeenCalled();

        dispatchState({ state: "idle" });
        expect(close).toHaveBeenCalledOnce();
    });
});
