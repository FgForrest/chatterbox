import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import cs from "../../../extensions/recorder/_locales/cs/messages.json";
import en from "../../../extensions/recorder/_locales/en/messages.json";
import { createCaptureHost } from "../../../extensions/recorder/lib/capture-host.js";
import { microphoneError } from "../../../extensions/recorder/lib/microphone.js";

vi.mock("../../../extensions/recorder/lib/chunk-crypto.js", () => ({
    importCaptureKey: vi.fn(async () => ({})),
    encryptChunk: vi.fn(),
}));
vi.mock("../../../extensions/recorder/lib/chunk-store.js", () => ({
    writeChunk: vi.fn(),
}));

function stream() {
    const track = {
        readyState: "live",
        stop: vi.fn(),
        addEventListener: vi.fn(),
    };
    return { getTracks: () => [track], getAudioTracks: () => [track], track };
}

let host;
let system;
let mic;
let recorder;
let getUserMedia;
let sources;
const input = {
    sessionId: "meeting-1",
    captureKey: "key",
    captureMode: "desktop",
    channelMode: "mixed",
    microphoneId: "unplugged-input",
};

beforeEach(() => {
    vi.useFakeTimers();
    system = stream();
    mic = stream();
    sources = [];
    getUserMedia = vi.fn(async () => mic);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("chrome", {
        runtime: { sendMessage: vi.fn(async () => {}) },
        i18n: { getMessage: (key) => en[key]?.message ?? "" },
    });
    const node = () => ({ connect: vi.fn(), getFloatTimeDomainData: vi.fn() });
    vi.stubGlobal(
        "AudioContext",
        class {
            destination = {};
            close = vi.fn(async () => {});
            createMediaStreamSource(value) {
                sources.push(value);
                return node();
            }
            createAnalyser = node;
            createMediaStreamDestination = () => ({ stream: {} });
            createChannelMerger = node;
            createDynamicsCompressor = () =>
                Object.assign(
                    node(),
                    Object.fromEntries(
                        ["threshold", "knee", "ratio", "attack", "release"].map(
                            (key) => [key, {}],
                        ),
                    ),
                );
        },
    );
    vi.stubGlobal(
        "MediaRecorder",
        class {
            state = "recording";
            start = vi.fn();
            stop() {
                this.state = "inactive";
                void this.onstop();
            }
            constructor() {
                recorder = this;
            }
        },
    );
    host = createCaptureHost();
});
afterEach(async () => {
    host.stop();
    await Promise.resolve();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("capture keeps the meeting when the microphone fails", () => {
    it("includes a working mic when withoutMicrophone is false", async () => {
        await host.start({
            ...input,
            systemStream: system,
            withoutMicrophone: false,
        });
        expect(sources).toEqual([system, mic]);
        expect(recorder.start).toHaveBeenCalled();
    });
    it("never opens the mic after the explicit withoutMicrophone choice", async () => {
        await host.start({
            ...input,
            systemStream: system,
            withoutMicrophone: true,
        });
        expect(getUserMedia).not.toHaveBeenCalled();
        expect(sources).toEqual([system]);
        expect(recorder.start).toHaveBeenCalled();
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "mic-unavailable" }),
        );
    });
    it.each([
        "OverconstrainedError",
        "NotFoundError",
    ])("retries %s once on the default input", async (name) => {
        getUserMedia.mockRejectedValueOnce(new DOMException("", name));
        await host.start({ ...input, systemStream: system });
        expect(getUserMedia).toHaveBeenCalledTimes(2);
        expect(getUserMedia.mock.calls[0][0].audio.deviceId).toEqual({
            exact: "unplugged-input",
        });
        expect(getUserMedia.mock.calls[1][0].audio.deviceId).toBeUndefined();
        expect(sources).toEqual([system, mic]);
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "mic-unavailable" }),
        );
    });
    it.each([
        "OverconstrainedError",
        "NotFoundError",
        "NotReadableError",
        "NotAllowedError",
        "SecurityError",
        "AbortError",
        "UnknownError",
    ])("continues recording and reports %s even with an empty error message", async (name) => {
        getUserMedia.mockRejectedValue(new DOMException("", name));
        await host.start({ ...input, systemStream: system });
        expect(host.isRecording()).toBe(true);
        expect(recorder.start).toHaveBeenCalled();
        expect(system.track.stop).not.toHaveBeenCalled();
        expect(sources).toEqual([system]);
        expect(getUserMedia).toHaveBeenCalledTimes(
            ["OverconstrainedError", "NotFoundError"].includes(name) ? 2 : 1,
        );
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "mic-unavailable",
            sessionId: "meeting-1",
            errorName: name,
        });
        for (const messages of [en, cs]) {
            chrome.i18n.getMessage = (key) => messages[key]?.message ?? "";
            expect(microphoneError(name).length).toBeGreaterThan(20);
            expect(microphoneError(name)).not.toContain(name);
        }
    });
    it.each([
        "OverconstrainedError",
        "NotFoundError",
    ])("does not retry the default input after %s when no device was chosen", async (name) => {
        getUserMedia.mockRejectedValue(new DOMException("", name));
        await host.start({ ...input, microphoneId: "", systemStream: system });
        expect(getUserMedia).toHaveBeenCalledTimes(1);
        expect(getUserMedia.mock.calls[0][0].audio.deviceId).toBeUndefined();
        expect(sources).toEqual([system]);
        expect(host.isRecording()).toBe(true);
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "mic-unavailable",
            sessionId: "meeting-1",
            errorName: name,
        });
    });
    it("reports the reason from the default-input retry", async () => {
        getUserMedia
            .mockRejectedValueOnce(new DOMException("", "NotFoundError"))
            .mockRejectedValueOnce(new DOMException("", "NotReadableError"));
        await host.start({ ...input, systemStream: system });
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ errorName: "NotReadableError" }),
        );
        expect(host.isRecording()).toBe(true);
    });
});
