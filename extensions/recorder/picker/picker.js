import { createCaptureHost, openSystemAudio } from "../lib/capture-host.js";
import { localizeDocument, t } from "../lib/i18n.js";

localizeDocument();

const requestId = new URL(location.href).searchParams.get("requestId");
const status = document.getElementById("picker-status");
const cancel = document.getElementById("picker-cancel");
const stop = document.getElementById("picker-stop");
const minimize = document.getElementById("picker-minimize");
const meters = document.getElementById("picker-meters");
const micBar = document.getElementById("picker-mic-bar");
const systemBar = document.getElementById("picker-system-bar");
let chooseRequestId = null;
let systemStream = null;
let recording = false;

function showError(error) {
    status.textContent = error?.message ?? String(error);
    status.classList.add("error");
}

function setLevel(element, db) {
    element.style.width = `${Math.max(0, Math.min(100, (db + 60) * 1.7))}%`;
}

const capture = createCaptureHost({
    onLevels: ({ micDb, systemDb }) => {
        setLevel(micBar, micDb);
        setLevel(systemBar, systemDb);
    },
    onStopped: () => {
        recording = false;
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
        status.textContent = t("startingCapture");
        const response = await report("desktop-capture-ready");
        if (!response?.ok) throw new Error(response?.error ?? t("couldNotStart"));
    } catch (error) {
        if (!recording) releaseSystemStream();
        await report("desktop-picker-error", error?.message ?? String(error)).catch(() => {});
        showError(error);
    }
})();
