// Audio capture, mixing, and chunking. Runs in the offscreen document.
//
// Receives a desktop capture stream id (system audio) and a microphone
// device id from the service worker, builds a two-channel stream with the
// microphone on the left and system audio on the right, and records it to
// WebM/Opus in fixed slices. Each slice is written to OPFS and announced to
// the service worker, which owns the upload queue.

import {
    AUDIO_BITS_PER_SECOND,
    CHANNEL_LAYOUT_MIXED,
    CHUNK_INTERVAL_MS,
    RECORDER_MIME_TYPE,
    SAMPLE_RATE,
} from "../lib/constants.js";
import { writeChunk } from "../lib/chunk-store.js";

/** @type {{recorder: MediaRecorder, context: AudioContext, streams: MediaStream[], sessionId: string, nextIndex: number, meterTimer: number|undefined, analysers: {mic: AnalyserNode, system: AnalyserNode}}|null} */
let active = null;

function send(message) {
    chrome.runtime.sendMessage(message).catch(() => {
        // Service worker may be momentarily asleep; it re-reads OPFS state
        // on wake, so a dropped notification is not fatal.
    });
}

async function openSystemAudio(streamId) {
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

function rmsToDb(analyser, buffer) {
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (const sample of buffer) sum += sample * sample;
    const rms = Math.sqrt(sum / buffer.length);
    if (rms <= 0) return -100;
    return Math.max(-100, 20 * Math.log10(rms));
}

async function start({
    sessionId,
    captureMode,
    channelMode,
    streamId,
    microphoneId,
}) {
    if (active) throw new Error("A recording is already in progress");

    const isTab = captureMode === "tab";
    const isSplit = channelMode === "split";

    // The meeting audio is the point of the recording, so a failure to open
    // it is fatal. The microphone is not: if it is denied, busy, or absent,
    // record the meeting alone rather than losing the whole session.
    let systemStream;
    try {
        systemStream = isTab
            ? await openTabAudio(streamId)
            : await openSystemAudio(streamId);
    } catch (error) {
        throw new Error(
            `Could not capture the meeting audio (${captureMode}): ${error?.name ?? ""} ${error?.message ?? error}`,
        );
    }

    let micStream = null;
    try {
        micStream = await openMicrophone(microphoneId);
    } catch (error) {
        send({
            type: "mic-unavailable",
            sessionId,
            message: error?.message ?? String(error),
        });
    }

    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
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

    active = {
        recorder,
        context,
        streams: [systemStream, micStream].filter(Boolean),
        sessionId,
        nextIndex: 0,
        meterTimer: undefined,
        analysers: { mic: micAnalyser, system: systemAnalyser },
        pendingWrites: [],
    };

    recorder.ondataavailable = (event) => {
        if (!active || event.data.size === 0) return;
        // Assign the index synchronously so the final blob flushed by
        // stop() is counted before onstop reads the total; buffer the write
        // so onstop can wait for it to land in OPFS before completing.
        const index = active.nextIndex++;
        const write = writeChunk(sessionId, index, event.data)
            .then(() => send({ type: "chunk-ready", sessionId, index }))
            .catch((error) =>
                send({
                    type: "capture-error",
                    sessionId,
                    message: `Could not buffer chunk ${index}: ${error?.message ?? error}`,
                }),
            );
        active.pendingWrites.push(write);
    };

    recorder.onstop = async () => {
        const current = active;
        if (!current) return;
        // Wait for the last slices to finish writing so the server sees every
        // chunk the count promises, then tear the graph down.
        await Promise.allSettled(current.pendingWrites);
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
    if (!active) return;
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== "offscreen") return false;
    if (message.type === "start") {
        start(message.payload)
            .then(() => sendResponse({ ok: true }))
            .catch((error) => {
                stop();
                sendResponse({ ok: false, error: error?.message ?? String(error) });
            });
        return true; // async response
    }
    if (message.type === "stop") {
        stop();
        sendResponse({ ok: true });
        return false;
    }
    if (message.type === "ping") {
        sendResponse({ ok: true, recording: Boolean(active) });
        return false;
    }
    return false;
});

// Announce readiness and the channel layout the service worker should report.
send({ type: "offscreen-ready", channelLayout: CHANNEL_LAYOUT_MIXED });
