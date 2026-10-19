import {
    AUDIO_BITS_PER_SECOND,
    CHUNK_INTERVAL_MS,
    RECORDER_MIME_TYPE,
    SAMPLE_RATE,
} from "./constants.js";
import { writeChunk } from "./chunk-store.js";
import { encryptChunk, importCaptureKey } from "./chunk-crypto.js";

const MAX_PENDING_WRITES = 3;

/** Consume a desktop stream ID in the same extension frame that requested it. */
export async function openSystemAudio(streamId) {
    // Chrome only yields desktop audio when a video track is also requested;
    // we stop the video track immediately and keep the audio.
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            mandatory: {
                chromeMediaSource: "desktop",
                chromeMediaSourceId: streamId,
            },
        },
        video: {
            mandatory: {
                chromeMediaSource: "desktop",
                chromeMediaSourceId: streamId,
            },
        },
    });
    for (const track of stream.getVideoTracks()) track.stop();
    return stream;
}

async function openTabAudio(streamId) {
    // Audio of one specific tab. Some Chrome versions reject an audio-only
    // tab capture, so request a video track too and discard it immediately,
    // mirroring the desktop path.
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            mandatory: {
                chromeMediaSource: "tab",
                chromeMediaSourceId: streamId,
            },
        },
        video: {
            mandatory: {
                chromeMediaSource: "tab",
                chromeMediaSourceId: streamId,
            },
        },
    });
    for (const track of stream.getVideoTracks()) track.stop();
    return stream;
}

async function openMicrophone(deviceId) {
    return navigator.mediaDevices.getUserMedia({
        audio: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            sampleRate: SAMPLE_RATE,
            // Raw mic: browser voice processing (AGC, denoise, AEC) muffles a
            // good microphone. Leave it off so the recording is the real signal.
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
        },
    });
}

async function openAvailableMicrophone(deviceId) {
    try {
        return await openMicrophone(deviceId);
    } catch (error) {
        if (
            deviceId &&
            ["OverconstrainedError", "NotFoundError"].includes(error?.name)
        )
            return openMicrophone();
        throw error;
    }
}

function rmsToDb(analyser, buffer) {
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (const sample of buffer) sum += sample * sample;
    const rms = Math.sqrt(sum / buffer.length);
    if (rms <= 0) return -100;
    return Math.max(-100, 20 * Math.log10(rms));
}

/** Capture audio in a persistent extension document and buffer encrypted chunks. */
export function createCaptureHost({ onLevels, onStopped } = {}) {
/** @type {{recorder: MediaRecorder, context: AudioContext, streams: MediaStream[], sessionId: string, nextIndex: number, meterTimer: number|undefined, analysers: {mic: AnalyserNode, system: AnalyserNode}}|null} */
let active = null;
let pendingCapture = null;

function send(message) {
    if (message.type === "levels") onLevels?.(message);
    if (message.type === "recording-stopped") onStopped?.(message);
    chrome.runtime.sendMessage(message).catch(() => {});
}

async function start(input) {
    if (active || pendingCapture) {
        throw new Error("A recording is already in progress");
    }
    const pending = { streams: [], context: null, stopRequested: false };
    pendingCapture = pending;
    try {
        await startCapture(input, pending);
    } catch (error) {
        if (active) {
            stop();
        } else {
            for (const stream of pending.streams) {
                for (const track of stream.getTracks()) track.stop();
            }
            await pending.context?.close().catch(() => {});
        }
        throw error;
    } finally {
        pendingCapture = null;
    }
}

async function startCapture({
    sessionId,
    clientRecordingId,
    captureKey,
    captureMode,
    channelMode,
    streamId,
    systemStream: providedSystemStream,
    microphoneId,
    withoutMicrophone = false,
}, pending) {
    if (captureMode !== "tab" && !providedSystemStream) {
        throw new Error("Desktop audio must be opened in the picker window");
    }
    const key = await importCaptureKey(captureKey);

    const isTab = captureMode === "tab";
    const isSplit = channelMode === "split";

    let systemStream = providedSystemStream;
    try {
        if (!systemStream) {
            systemStream = await openTabAudio(streamId);
        }
    } catch (error) {
        throw new Error(
            `Could not capture the meeting audio (${captureMode}): ${error?.name ?? ""} ${error?.message ?? error}`,
        );
    }
    pending.streams.push(systemStream);
    if (systemStream.getAudioTracks().every((track) => track.readyState === "ended")) {
        throw new Error("The selected audio source has stopped");
    }

    let micStream = null;
    let micErrorName = null;
    if (!withoutMicrophone) {
        try {
            micStream = await openAvailableMicrophone(microphoneId);
            pending.streams.push(micStream);
        } catch (error) {
            micErrorName = error?.name || "UnknownError";
        }
    }

    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    pending.context = context;
    const systemSource = context.createMediaStreamSource(systemStream);
    const micSource = micStream
        ? context.createMediaStreamSource(micStream)
        : null;

    const micAnalyser = context.createAnalyser();
    micAnalyser.fftSize = 1024;
    micSource?.connect(micAnalyser);
    const systemAnalyser = context.createAnalyser();
    systemAnalyser.fftSize = 1024;
    systemSource.connect(systemAnalyser);

    const destination = context.createMediaStreamDestination();

    if (isSplit && micSource) {
        // Microphone -> left channel, system -> right channel.
        const merger = context.createChannelMerger(2);
        micSource.connect(merger, 0, 0);
        systemSource.connect(merger, 0, 1);
        merger.connect(destination);
    } else {
        // Natural centered mix (also the mic-less path). Sum through a limiter
        // so a loud moment on both at once cannot clip the combined signal.
        const limiter = context.createDynamicsCompressor();
        limiter.threshold.value = -3;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.25;
        micSource?.connect(limiter);
        systemSource.connect(limiter);
        limiter.connect(destination);
    }

    // Capturing a tab's audio silences it for the user; route the tab audio
    // to the speakers so the meeting stays audible while recording. Desktop
    // capture already plays through the system, so routing it back would
    // double it and echo -- only do this in tab mode.
    if (isTab) {
        systemSource.connect(context.destination);
    }

    const recorder = new MediaRecorder(destination.stream, {
        mimeType: RECORDER_MIME_TYPE,
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    });

    if (pending.stopRequested) throw new Error("Capture stopped before start");

    active = {
        recorder,
        context,
        streams: [systemStream, micStream].filter(Boolean),
        sessionId,
        clientRecordingId,
        key,
        nextIndex: 0,
        meterTimer: undefined,
        analysers: { mic: micAnalyser, system: systemAnalyser },
        pendingWrites: new Set(),
        writeFailed: false,
    };

    recorder.ondataavailable = (event) => {
        if (!active || event.data.size === 0 || active.writeFailed) return;
        const current = active;
        if (current.pendingWrites.size >= MAX_PENDING_WRITES) {
            current.writeFailed = true;
            send({
                type: "capture-error",
                sessionId,
                message: "Encrypted buffer could not keep up with capture",
            });
            stop();
            return;
        }
        // Assign the index synchronously so the final blob flushed by
        // stop() is counted before onstop reads the total; buffer the write
        // so onstop can wait for it to land in OPFS before completing.
        const index = current.nextIndex++;
        const write = encryptChunk(key, clientRecordingId, index, event.data)
            .then((encrypted) => writeChunk(sessionId, index, encrypted))
            .then(() => send({ type: "chunk-ready", sessionId, index }))
            .catch((error) => {
                current.writeFailed = true;
                send({
                    type: "capture-error",
                    sessionId,
                    message: `Could not buffer chunk ${index}: ${error?.message ?? error}`,
                });
                stop();
            })
            .finally(() => current.pendingWrites.delete(write));
        current.pendingWrites.add(write);
    };

    recorder.onstop = async () => {
        const current = active;
        if (!current) return;
        // Wait for the last slices to finish writing so the server sees every
        // chunk the count promises, then tear the graph down.
        await Promise.allSettled([...current.pendingWrites]);
        const chunkCount = current.nextIndex;
        cleanup(current);
        active = null;
        send({ type: "recording-stopped", sessionId, chunkCount });
    };

    recorder.onerror = (event) => {
        send({
            type: "capture-error",
            sessionId,
            message: `Recorder error: ${event?.error?.message ?? "unknown"}`,
        });
    };

    // The user pressing Chrome's own "Stop sharing" ends the system track.
    systemStream.getAudioTracks()[0]?.addEventListener("ended", () => {
        send({ type: "stream-ended", sessionId });
    });
    micStream?.getAudioTracks()[0]?.addEventListener("ended", () => {
        if (active?.sessionId === sessionId) {
            send({ type: "mic-unavailable", sessionId, errorName: "TrackEnded" });
        }
    });

    // Live meters, reported a few times a second.
    const micBuffer = new Float32Array(micAnalyser.fftSize);
    const systemBuffer = new Float32Array(systemAnalyser.fftSize);
    active.meterTimer = setInterval(() => {
        send({
            type: "levels",
            sessionId,
            micDb: rmsToDb(micAnalyser, micBuffer),
            systemDb: rmsToDb(systemAnalyser, systemBuffer),
        });
    }, 200);

    recorder.start(CHUNK_INTERVAL_MS);
    send({ type: "recording-started", sessionId });
    if (micErrorName)
        send({ type: "mic-unavailable", sessionId, errorName: micErrorName });
    if (pending.stopRequested) stop();
}

/** Tear down capture resources. Called from onstop, after the final flush. */
function cleanup(session) {
    if (session.meterTimer) {
        clearInterval(session.meterTimer);
        session.meterTimer = undefined;
    }
    for (const stream of session.streams) {
        for (const track of stream.getTracks()) track.stop();
    }
    session.context.close().catch(() => {});
}

function stop() {
    if (!active) {
        if (pendingCapture) pendingCapture.stopRequested = true;
        return;
    }
    // Stop metering immediately, then ask the recorder to stop. The final
    // dataavailable and onstop do the rest: they flush the last chunk, report
    // the true count, and only then release the streams and audio graph.
    if (active.meterTimer) {
        clearInterval(active.meterTimer);
        active.meterTimer = undefined;
    }
    try {
        if (active.recorder.state !== "inactive") {
            active.recorder.stop();
        } else {
            // Never started or already finished: clean up here since onstop
            // will not fire.
            cleanup(active);
            const chunkCount = active.nextIndex;
            const sessionId = active.sessionId;
            active = null;
            send({ type: "recording-stopped", sessionId, chunkCount });
        }
    } catch {
        // already stopped; onstop will finish the teardown
    }
}

return { start, stop, isRecording: () => Boolean(active) };
}
