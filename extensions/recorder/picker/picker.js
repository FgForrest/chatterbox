import { createCaptureHost, openSystemAudio } from "../lib/capture-host.js";
import { RECORDER_WINDOW_WIDTH, STATE } from "../lib/constants.js";
import { fitWindowToContent } from "../lib/fit-window.js";
import { localizeDocument, t } from "../lib/i18n.js";

import { createRecordingFolder } from "../popup/folder-combobox.js";

localizeDocument();

const requestId = new URL(location.href).searchParams.get("requestId");
const status = document.getElementById("picker-status");
const cancel = document.getElementById("picker-cancel");
const stop = document.getElementById("picker-stop");
const minimize = document.getElementById("picker-minimize");
const meters = document.getElementById("picker-meters");
const controls = document.getElementById("picker-controls");
const instruction = document.getElementById("picker-instruction");
const progress = document.getElementById("picker-progress");
const completedView = document.getElementById("picker-completed");
const micBar = document.getElementById("picker-mic-bar");
const systemBar = document.getElementById("picker-system-bar");
const silentHint = document.getElementById("picker-silent");
const SILENT_DB = -50;
const SILENT_HINT_MS = 20_000;
const recordingFolder = createRecordingFolder({
    container: document.getElementById("picker-folder-row"), prefix: "picker-folder",
    request: (params) => chrome.runtime.sendMessage({ type: "get-folders", ...params }),
    send: (message) => chrome.runtime.sendMessage(message), t,
});
let chooseRequestId = null;
let systemSilentSince = null;
let systemStream = null;
let recording = false;
let completed = false;
let elapsedTimer;
let finalizationTimer;

function showError(error) {
    status.textContent = error?.message ?? String(error);
    status.classList.add("error");
}

function setLevel(element, db) {
    element.style.width = `${Math.max(0, Math.min(100, (db + 60) * 1.7))}%`;
}

// A shared window, screen or wrong tab records no meeting audio: say so
// while there is still time to share the meeting tab instead.
function noteSystemLevel(db) {
    if (!recording || db > SILENT_DB) {
        systemSilentSince = null;
        silentHint.hidden = true;
        return;
    }
    systemSilentSince ??= Date.now();
    if (Date.now() - systemSilentSince >= SILENT_HINT_MS) silentHint.hidden = false;
}

function formatElapsed(startedAt) {
    const seconds = Math.max(
        0,
        Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000),
    );
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function renderState(state) {
    if (state.state === STATE.idle && completed) {
        window.close();
        return;
    }
    if (state.pickerRequestId !== requestId) return;
    recordingFolder.render(state);

    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = undefined;
    if (state.state === STATE.finalizing && !finalizationTimer) {
        finalizationTimer = setInterval(() => {
            void chrome.runtime.sendMessage({ type: "check-finalization" }).catch(() => {});
        }, 5000);
    } else if (state.state !== STATE.finalizing && finalizationTimer) {
        clearInterval(finalizationTimer);
        finalizationTimer = undefined;
    }

    if (state.state === STATE.completed) {
        completed = true;
        status.hidden = true;
        meters.hidden = true;
        controls.hidden = true;
        progress.hidden = true;
        completedView.hidden = false;
        document.getElementById("picker-completion-check").hidden = Boolean(state.partial);
        document.getElementById("picker-completion-message").textContent = t(
            state.partial ? "partialRecordingSent" : "recordingStored",
        );
        return;
    }

    if ((state.state === STATE.recording && state.stopped) || state.state === STATE.finalizing) {
        const total = Math.max(0, state.chunkCount ?? 0);
        const uploaded = Math.min(total, state.uploaded?.length ?? 0);
        const processing = state.state === STATE.finalizing;
        status.hidden = true;
        meters.hidden = true;
        controls.hidden = true;
        progress.hidden = false;
        completedView.hidden = true;
        document.getElementById("picker-progress-stage").textContent = t(
            processing ? "processingRecording" : "uploadingRecording",
        );
        document.getElementById("picker-upload").hidden = processing;
        document.getElementById("picker-processing").hidden = !processing;
        const percent = total > 0 ? Math.round((uploaded / total) * 100) : 0;
        const progressBar = document.getElementById("picker-upload-progress");
        progressBar.setAttribute("aria-valuenow", String(percent));
        progressBar.setAttribute("aria-label", t("uploadProgress"));
        document.getElementById("picker-upload-progress-fill").style.width = `${percent}%`;
        document.getElementById("picker-upload-status").textContent = t("uploadedOf", [
            String(uploaded),
            String(total),
        ]);
        if (processing) {
            document.getElementById("picker-processing-status").textContent = t(
                "uploadComplete",
                String(total),
            );
            const startedAt = state.finalizingAt ?? new Date().toISOString();
            const tick = () => {
                document.getElementById("picker-processing-elapsed").textContent = t(
                    "processingElapsed",
                    formatElapsed(startedAt),
                );
            };
            tick();
            elapsedTimer = setInterval(tick, 1000);
        }
        return;
    }

    if (state.state === STATE.error) {
        progress.hidden = true;
        completedView.hidden = true;
        status.hidden = false;
        showError(new Error(state.error ?? t("somethingWrong")));
    }
}

const capture = createCaptureHost({
    onLevels: ({ micDb, systemDb }) => {
        setLevel(micBar, micDb);
        setLevel(systemBar, systemDb);
        noteSystemLevel(systemDb);
    },
    onStopped: () => {
        recording = false;
        silentHint.hidden = true;
        stop.disabled = true;
        status.textContent = t("finishing");
    },
});

function releaseSystemStream() {
    for (const track of systemStream?.getTracks() ?? []) track.stop();
    systemStream = null;
}

function chooseDesktopMedia() {
    return new Promise((resolve, reject) => {
        try {
            chooseRequestId = chrome.desktopCapture.chooseDesktopMedia(
                ["tab", "screen", "audio"],
                async (streamId, options) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message ?? t("couldNotCapture")));
                        return;
                    }
                    if (!streamId) {
                        resolve(false);
                        return;
                    }
                    if (options?.canRequestAudioTrack !== true) {
                        reject(new Error(t("sourceHasNoAudio")));
                        return;
                    }
                    try {
                        systemStream = await openSystemAudio(streamId);
                        if (systemStream.getAudioTracks().length === 0) {
                            releaseSystemStream();
                            throw new Error(t("sourceHasNoAudio"));
                        }
                        resolve(true);
                    } catch (error) {
                        reject(error);
                    }
                },
            );
        } catch (error) {
            reject(error);
        }
    });
}

async function fitToRecorder() {
    const current = await chrome.windows.getCurrent().catch(() => null);
    if (current?.state === "normal") {
        await chrome.windows
            .update(current.id, { width: RECORDER_WINDOW_WIDTH })
            .catch(() => {});
    }
    fitWindowToContent();
}

async function report(type, error) {
    return chrome.runtime.sendMessage({ type, requestId, error });
}

cancel.addEventListener("click", async () => {
    if (chooseRequestId != null) {
        chrome.desktopCapture.cancelChooseDesktopMedia(chooseRequestId);
    }
    releaseSystemStream();
    await report("desktop-picker-cancelled").catch(() => {});
    window.close();
});

stop.addEventListener("click", async () => {
    await recordingFolder.saved();
    stop.disabled = true;
    status.textContent = t("finishing");
    const response = await chrome.runtime.sendMessage({ type: "stop-recording" });
    if (!response?.ok) {
        stop.disabled = false;
        showError(new Error(response?.error ?? t("couldNotStart")));
    }
});

minimize.addEventListener("click", async () => {
    const current = await chrome.windows.getCurrent();
    await chrome.windows.update(current.id, { state: "minimized" });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "state") {
        renderState(message.state);
        return false;
    }
    if (message?.target !== "desktop-recorder" || message.requestId !== requestId) {
        return false;
    }
    if (message.type === "start") {
        capture.start({ ...message.payload, systemStream })
            .then(() => {
                recording = true;
                cancel.hidden = true;
                stop.hidden = false;
                minimize.hidden = false;
                meters.hidden = false;
                instruction.hidden = true;
                status.textContent = t("recording");
                sendResponse({ ok: true });
            })
            .catch((error) => {
                releaseSystemStream();
                showError(error);
                sendResponse({ ok: false, error: error?.message ?? String(error) });
            });
        return true;
    }
    if (message.type === "stop") {
        capture.stop();
        sendResponse({ ok: true });
        return false;
    }
    return false;
});

(async () => {
    try {
        if (!requestId) throw new Error(t("couldNotStart"));
        const chosen = await chooseDesktopMedia();
        if (!chosen) {
            await report("desktop-picker-cancelled");
            window.close();
            return;
        }
        await fitToRecorder();
        status.textContent = t("startingCapture");
        const response = await report("desktop-capture-ready");
        if (!response?.ok) throw new Error(response?.error ?? t("couldNotStart"));
    } catch (error) {
        if (!recording) releaseSystemStream();
        await report("desktop-picker-error", error?.message ?? String(error)).catch(() => {});
        showError(error);
        await fitToRecorder();
    }
})();
