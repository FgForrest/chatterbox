import { afterEach, expect, it, vi } from "vitest";
import { createCaptureHost } from "../../../extensions/recorder/lib/capture-host.js";
import vectors from "../fixtures/recorder-sealed-vectors.json";

const { readLocalMeta, writeCaptureSealing, writeCaptureStop, writeChunk } =
    vi.hoisted(() => ({
        readLocalMeta: vi.fn(),
        writeCaptureSealing: vi.fn(async () => {}),
        writeCaptureStop: vi.fn(async () => {}),
        writeChunk: vi.fn(async () => {}),
    }));

vi.mock("../../../extensions/recorder/lib/chunk-store.js", () => ({
    readLocalMeta,
    writeCaptureSealing,
    writeCaptureStop,
    writeChunk,
}));

afterEach(() => {
    vi.clearAllMocks();
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
    readLocalMeta.mockResolvedValue({});
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
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
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
        fireChunk: (data) => recorder.ondataavailable({ data }),
        getUserMedia,
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

it("acknowledges Stop during microphone startup and never starts the recorder", async () => {
    const { host, input, startRecorder, sendMessage, getUserMedia, track } =
        setupCapture();
    const opening = Promise.withResolvers();
    const microphone = Promise.withResolvers();
    getUserMedia.mockImplementationOnce(() => {
        opening.resolve();
        return microphone.promise;
    });
    const captureId = "capture-one";
    const start = host.start({ ...input, captureId, withoutMicrophone: false });
    await opening.promise;
    expect(host.stop("different-capture")).toBe(false);
    expect(host.stop(captureId)).toBe(true);
    expect(host.stop(captureId)).toBe(true);
    expect(host.captureId()).toBeNull();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
        type: "recording-stopped",
        captureId,
        chunkCount: 0,
        stoppedAt: expect.any(String),
    });
    const micTrack = { stop: vi.fn() };
    microphone.resolve({ getTracks: () => [micTrack] });
    expect(await start).toBe(false);
    expect(micTrack.stop).toHaveBeenCalledOnce();
    expect(startRecorder).not.toHaveBeenCalled();
    expect(host.captureId()).toBeNull();
});

it("refuses a late Start after the capture was durably stopped", async () => {
    const { host, input, getUserMedia, startRecorder } = setupCapture();
    readLocalMeta.mockResolvedValueOnce({
        stopRequestedAt: new Date().toISOString(),
    });
    await expect(
        host.start({
            ...input,
            captureId: "capture-one",
            captureMode: "tab",
            systemStream: undefined,
        }),
    ).rejects.toThrow("Capture stopped before start");
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(startRecorder).not.toHaveBeenCalled();
});

it("waits for the first encrypted chunk to commit before reporting Stop", async () => {
    const { host, input, fireChunk, fireStop, sendMessage } = setupCapture();
    const captureId = "capture-one";
    const writing = Promise.withResolvers();
    writeChunk.mockReturnValueOnce(writing.promise);
    await host.start({ ...input, captureId });
    fireChunk(new Blob(["audio"]));
    expect(host.stop(captureId)).toBe(true);
    const stopped = fireStop();
    expect(sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "recording-stopped" }),
    );
    writing.resolve();
    await stopped;
    expect(writeChunk).toHaveBeenCalledWith(captureId, 0, expect.any(Blob));
    expect(writeCaptureStop).toHaveBeenCalledWith(captureId, {
        chunkCount: 1,
        stoppedAt: expect.any(String),
    });
    expect(sendMessage.mock.calls.map(([message]) => message.type)).toEqual([
        "recording-started",
        "chunk-ready",
        "recording-stopped",
    ]);
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

it("commits the public descriptor before starting sealed capture and stops at the encrypted byte cap", async () => {
    const {
        host,
        input,
        fireChunk,
        fireStop,
        startRecorder,
        stopRecorder,
        sendMessage,
    } = setupCapture();
    const captureId = "sealed-capture";
    const recipient = {
        kid: vectors.kid,
        publicKey: vectors.recipient.publicKey,
    };
    readLocalMeta.mockResolvedValueOnce({ protocol: 2 });
    writeCaptureSealing.mockImplementationOnce(async (_id, sealing) => {
        expect(startRecorder).not.toHaveBeenCalled();
        expect(sealing).toMatchObject({ protocol: 2, kid: vectors.kid });
        expect(sealing.ephemeralPublicKey).toHaveLength(87);
        expect(sealing.salt).toHaveLength(22);
    });
    await host.start({ ...input, captureId, recipient, maxSessionBytes: 34 });
    fireChunk(new Blob(["audio"]));
    fireChunk(new Blob(["audio"]));
    expect(stopRecorder).toHaveBeenCalledOnce();
    await fireStop();
    expect(writeChunk).toHaveBeenCalledExactlyOnceWith(
        captureId,
        0,
        expect.any(Blob),
    );
    expect(sendMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ chunkCount: 1, limitReached: true }),
    );
});

it("serializes writes and retains only the verified prefix after OPFS fails", async () => {
    const { host, input, fireChunk, fireStop, sendMessage } = setupCapture();
    const captureId = "sealed-capture";
    const writing = Promise.withResolvers();
    writeChunk
        .mockImplementationOnce(() => writing.promise)
        .mockRejectedValueOnce(new Error("storage full"));
    await host.start({ ...input, captureId });
    fireChunk(new Blob(["first"]));
    fireChunk(new Blob(["second"]));
    fireChunk(new Blob(["third"]));
    writing.resolve();
    await fireStop();
    expect(writeChunk.mock.calls.map(([, index]) => index)).toEqual([0, 1]);
    expect(sendMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ chunkCount: 1, interrupted: true }),
    );
});
