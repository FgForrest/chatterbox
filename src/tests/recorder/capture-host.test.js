import { afterEach, expect, it, vi } from "vitest";
import { createCaptureHost } from "../../../extensions/recorder/lib/capture-host.js";

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function setupCapture() {
    vi.useFakeTimers();
    const track = {
        readyState: "live",
        addEventListener: vi.fn(),
        stop: vi.fn(),
    };
    const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
    const close = vi.fn(async () => {});
    const sendMessage = vi.fn(async () => {});
    let recorder;
    const startRecorder = vi.fn(function () {
        this.state = "recording";
    });
    const stopRecorder = vi.fn(function () {
        this.state = "inactive";
    });
    class FakeMediaRecorder {
        state = "inactive";
        start = startRecorder;
        stop = stopRecorder;

        constructor() {
            recorder = this;
        }
    }
    const spectra = [
        [
            [4, -25],
            [11, -51],
            [35, -17],
            [100, -33],
        ],
        [
            [1, -5],
            [4, -45],
            [11, -12],
            [35, -53],
            [100, -28],
            [200, -5],
        ],
    ];
    class FakeAudioContext {
        close = close;
        sampleRate = 48_000;
        analyserCount = 0;

        createMediaStreamSource() {
            return { connect: vi.fn() };
        }
        createAnalyser() {
            const channel = this.analyserCount++;
            return {
                frequencyBinCount: 512,
                getFloatTimeDomainData: (buffer) =>
                    buffer.fill(channel === 0 ? 0.5 : 0.25),
                getFloatFrequencyData: (buffer) => {
                    buffer.fill(-Infinity);
                    for (const [bin, db] of spectra[channel]) buffer[bin] = db;
                },
            };
        }
        createMediaStreamDestination() {
            return { stream };
        }
        createDynamicsCompressor() {
            return {
                connect: vi.fn(),
                threshold: {},
                knee: {},
                ratio: {},
                attack: {},
                release: {},
            };
        }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("navigator", {
        mediaDevices: { getUserMedia: async () => stream },
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const host = createCaptureHost();
    const input = {
        sessionId: "session-1",
        clientRecordingId: "capture-1",
        captureKey: btoa("\0".repeat(32)),
        captureMode: "desktop",
        systemStream: stream,
        withoutMicrophone: true,
    };
    return {
        host,
        input,
        startRecorder,
        stopRecorder,
        fireStop: () => recorder.onstop(),
        sendMessage,
        spectra,
        track,
        close,
    };
}

it("emits recording-stopped once when asked to stop twice before onstop", async () => {
    const { host, input, stopRecorder, fireStop, sendMessage, track, close } =
        setupCapture();
    await host.start(input);

    host.stop();
    host.stop();

    expect(stopRecorder).toHaveBeenCalledOnce();
    expect(host.isRecording()).toBe(true);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
        type: "recording-started",
        sessionId: input.sessionId,
    });

    await fireStop();
    const stopped = sendMessage.mock.calls
        .flat()
        .filter(({ type }) => type === "recording-stopped");
    expect(stopped).toEqual([
        {
            type: "recording-stopped",
            sessionId: input.sessionId,
            chunkCount: 0,
        },
    ]);
    expect(host.isRecording()).toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
});

it("releases capture resources and clears active when MediaRecorder.start throws", async () => {
    const { host, input, startRecorder, sendMessage, track, close } =
        setupCapture();
    startRecorder.mockImplementationOnce(() => {
        throw new Error("Could not start recorder");
    });

    await expect(host.start(input)).rejects.toThrow("Could not start recorder");

    expect(host.isRecording()).toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
});

it("reports independent peak levels for each channel and frequency band on the meter timer", async () => {
    const { host, input, sendMessage, spectra, fireStop } = setupCapture();
    await host.start({ ...input, withoutMicrophone: false });

    await vi.advanceTimersByTimeAsync(199);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sendMessage).toHaveBeenLastCalledWith({
        type: "levels",
        sessionId: input.sessionId,
        micDb: 20 * Math.log10(0.5),
        systemDb: 20 * Math.log10(0.25),
        micBands: [-25, -51, -17, -33],
        systemBands: [-45, -12, -53, -28],
    });
    spectra[0].length = 0;
    await vi.advanceTimersByTimeAsync(200);
    expect(sendMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
            micBands: [-100, -100, -100, -100],
            systemBands: [-45, -12, -53, -28],
        }),
    );
    host.stop();
    await fireStop();
});
