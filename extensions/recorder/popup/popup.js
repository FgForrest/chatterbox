// Popup UI: manual start, live meters, error
// recovery, and the first-contact "Connect to this site" bootstrap for
// self-hosted Chatterbox instances.
//
// On tabs armed in auto mode the popup is disabled entirely (the toolbar
// click starts recording directly), so this UI only appears elsewhere.

import { createAgendaCard } from "../lib/agenda-card.js";
import { agendaFolder, supportsAgendas } from "../lib/agendas.js";
import { STATE } from "../lib/constants.js";
import { localizeDocument, t } from "../lib/i18n.js";
import { bindMeetingPromptOffer } from "../lib/meeting-prompt-ui.js";
import { microphonePermission } from "../lib/microphone.js";
import { originOf } from "../lib/pairing.js";
import { detectMeetingPlatform } from "../lib/platforms.js";
import {
    effectiveNoticeText,
    effectivePlatformModes,
    getSettings,
    isPaired,
    saveSettings,
} from "../lib/settings.js";

import { createFolderField, createRecordingFolder } from "./folder-combobox.js";

const views = {
    connect: document.getElementById("view-connect"),
    unpaired: document.getElementById("view-unpaired"),
    idle: document.getElementById("view-idle"),
    recording: document.getElementById("view-recording"),
    finalizing: document.getElementById("view-finalizing"),
    completed: document.getElementById("view-completed"),
    error: document.getElementById("view-error"),
};

localizeDocument();

const el = (id) => document.getElementById(id);

let elapsedTimer;
let finalizationTimer;
let renderVersion = 0;
let currentSessionId = null;
let currentRecoverablePrefix = null;
let currentTab = null;
let currentPlatform = null;
let currentState = { state: STATE.idle };

async function renderMicrophoneWarning(state) {
    const settings = await getSettings();
    if (!settings.dataUseAcknowledgedAt) {
        el("mic-warning").hidden = true;
        return;
    }
    const permission = await microphonePermission();
    const reminder = settings.dataUseAcknowledgedAt && !settings.micReminderDismissed && permission !== "granted";
    el("mic-warning").hidden = !settings.dataUseAcknowledgedAt || !(state.micWarning || reminder);
    el("mic-warning-text").textContent = state.micWarning || t("micWarning");
    el("dismiss-mic").hidden = !reminder || !state.withoutMicrophone || Boolean(state.micWarning);
}

function show(name) {
    for (const [key, node] of Object.entries(views)) {
        node.hidden = key !== name;
    }
}

function sendMessage(message) {
    return chrome.runtime.sendMessage(message);
}

async function activeTab() {
    const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
    });
    return tab ?? null;
}

function formatElapsed(startedAt) {
    if (!startedAt) return "0:00";
    const seconds = Math.max(
        0,
        Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000),
    );
    const m = Math.floor(seconds / 60);
    const s = String(seconds % 60).padStart(2, "0");
    return `${m}:${s}`;
}

function dbToWidth(db) {
    const clamped = Math.max(-60, Math.min(0, db));
    return `${Math.round(((clamped + 60) / 60) * 100)}%`;
}

let popupFolderChoice;
const folderCombobox = createFolderField({
    container: el("folder-row"),
    request: (params) => sendMessage({ type: "get-folders", ...params }),
    save: (folder) => { popupFolderChoice = folder; return saveSettings(folder); },
    saveOnRefresh: saveSettings,
    t,
});
const recordingFolder = createRecordingFolder({
    container: el("recording-folder-row"), prefix: "recording-folder",
    request: (params) => sendMessage({ type: "get-folders", ...params }),
    send: sendMessage, t,
});

let agendaCard;
async function renderAgendaCard(settings, state) {
    const container = el("agenda-card");
    if (!container) return;
    if (!supportsAgendas(settings)) { container.hidden = true; return; }
    agendaCard ??= createAgendaCard(container, {
        tab: () => currentTab,
        onFolder: (agenda) => { if (currentState.state === STATE.idle && !popupFolderChoice) folderCombobox.reset(agendaFolder(agenda), { refresh: false }); },
    });
    await agendaCard(settings, state);
}

// ---- Unpaired: connect to the current site ------------------------------

async function renderUnpaired() {
    const origin = currentTab?.url ? originOf(currentTab.url) : null;
    const isMeeting = currentTab?.url
        ? Boolean(detectMeetingPlatform(currentTab.url))
        : false;
    if (origin && !isMeeting) {
        el("connect-origin").textContent = t("connectTo", origin);
        el("connect-status").textContent = "";
        show("connect");
    } else {
        show("unpaired");
    }
}

el("connect-origin").addEventListener("click", async () => {
    const origin = currentTab?.url ? originOf(currentTab.url) : null;
    if (!origin || !currentTab) return;
    await chrome.tabs.create({
        url: chrome.runtime.getURL(
            `options/options.html?origin=${encodeURIComponent(origin)}&tabId=${currentTab.id}`,
        ),
    });
    window.close();
});

el("connect-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
});

// ---- Idle / manual start ------------------------------------------------

async function renderIdle(version = renderVersion) {
    const settings = await getSettings();
    if (version !== renderVersion) return;
    const hint = el("idle-hint");
    const autoHint = el("auto-hint");
    autoHint.hidden = true;
    el("start").textContent = t("recordTabWithConsent");
    el("notice-text").textContent = effectiveNoticeText(settings);
    el("picker-hint").hidden = false;
    folderCombobox.reset(popupFolderChoice ?? settings);

    if (currentPlatform) {
        hint.textContent = t("recordThis", currentPlatform.name);
        const mode = effectivePlatformModes(settings)[currentPlatform.id]?.mode;
        if (mode === "off") {
            autoHint.hidden = false;
            autoHint.textContent = t("autoTip", currentPlatform.name);
        }
    } else {
        hint.textContent = t("noMeeting");
    }
    show("idle");
    void renderAgendaCard(settings, currentState);
}

async function startRecording(forceDesktop = false) {
    const agendaChoice = agendaCard?.choice() ?? {};
    const button = el(forceDesktop ? "start-desktop" : "start");
    el("start").disabled = true;
    el("start-desktop").disabled = true;
    button.textContent = t(forceDesktop ? "openingPicker" : "startingCapture");
    try {
        await folderCombobox.saved();
        const response = await sendMessage({
            type: "start-recording",
            payload: {
                forceDesktop,
                tabId: currentTab?.id,
                platformHint: currentPlatform?.id ?? undefined,
                noticeAcknowledgedAt: new Date().toISOString(),
                ...agendaChoice,
                ...(popupFolderChoice ?? {}),
            },
        });
        if (response?.ok !== true) {
            throw new Error(response?.error ?? t("couldNotStart"));
        }
        window.close();
    } catch (error) {
        el("error-text").textContent = error?.message ?? String(error);
        show("error");
    } finally {
        el("start").disabled = false;
        el("start-desktop").disabled = false;
        button.textContent = t(forceDesktop ? "recordAnotherSource" : "recordTabWithConsent");
    }
}
el("start").addEventListener("click", () => startRecording());
el("start-desktop").addEventListener("click", () => startRecording(true));

// ---- Recording / finalizing / error --------------------------------------

function renderUploadStatus(state, elementId = "upload-status") {
    const node = el(elementId);
    if (!node) return;
    const uploaded = state.uploaded?.length ?? 0;
    const progress = state.stopped
        ? t("uploadedOf", [String(uploaded), String(state.chunkCount)])
        : t("segmentsUploaded", String(uploaded));
    node.textContent = state.uploadNotice
        ? `${progress} ${state.uploadNotice}`
        : progress;
}

function renderFinalizing(state) {
    const total = Math.max(0, state.chunkCount ?? 0);
    const uploaded = Math.min(total, state.uploaded?.length ?? 0);
    const percent = total > 0 ? Math.round((uploaded / total) * 100) : 0;
    const processing = state.state === STATE.finalizing;
    el("finalizing-stage").textContent = t(
        processing ? "processingRecording" : "uploadingRecording",
    );
    el("finalizing-upload").hidden = processing;
    el("finalizing-processing").hidden = !processing;
    el("finalizing-progress").setAttribute("aria-valuenow", String(percent));
    el("finalizing-progress").setAttribute("aria-label", t("uploadProgress"));
    el("finalizing-progress-fill").style.width = `${percent}%`;
    renderUploadStatus(state, "finalizing-status");
    if (processing) {
        el("processing-status").textContent = t("uploadComplete", String(total));
        const startedAt = state.finalizingAt ?? new Date().toISOString();
        const tick = () => {
            el("processing-elapsed").textContent = t(
                "processingElapsed",
                formatElapsed(startedAt),
            );
        };
        tick();
        elapsedTimer = setInterval(tick, 1000);
    }
    show("finalizing");
}

async function render(state) {
    const version = ++renderVersion;
    currentState = state;
    if (state.state !== STATE.idle)
        void getSettings().then((settings) => renderAgendaCard(settings, state));
    await renderMicrophoneWarning(state);
    if (version !== renderVersion) return;
    currentSessionId = state.sessionId;
    currentRecoverablePrefix = state.recoverablePrefix;
    if (elapsedTimer) {
        clearInterval(elapsedTimer);
        elapsedTimer = undefined;
    }

    const paired = await isPaired();
    if (version !== renderVersion) return;
    void renderMeetingPromptOffer(paired).catch(() => {});
    if (!paired) {
        await renderUnpaired();
        return;
    }

    if (state.state === STATE.finalizing && !finalizationTimer) {
        finalizationTimer = setInterval(() => {
            void sendMessage({ type: "check-finalization" }).catch(() => {});
        }, 5000);
    } else if (state.state !== STATE.finalizing && finalizationTimer) {
        clearInterval(finalizationTimer);
        finalizationTimer = undefined;
    }

    switch (state.state) {
        case STATE.recording: {
            if (state.stopped) {
                renderFinalizing(state);
                break;
            }
            show("recording");
            recordingFolder.render(state);
            const tick = () => {
                el("elapsed").textContent = formatElapsed(state.startedAt);
            };
            tick();
            elapsedTimer = setInterval(tick, 1000);
            renderUploadStatus(state);
            break;
        }
        case STATE.finalizing:
            renderFinalizing(state);
            break;
        case STATE.completed:
            el("completion-check").hidden = Boolean(state.partial);
            el("completion-message").textContent = t(
                state.partial ? "partialRecordingSent" : "recordingStored",
            );
            el("completion-agenda-notice").textContent = state.agendaUnavailable ? t("agendaUnavailable") : "";
            show("completed");
            break;
        case STATE.awaitingPicker:
            show("idle");
            el("idle-hint").textContent = t("waitingPicker");
            break;
        case STATE.error:
            show("error");
            el("error-text").textContent = state.error ?? t("somethingWrong");
            el("partial-recovery").hidden = !(state.recoverablePrefix > 0);
            if (state.recoverablePrefix > 0) {
                el("partial-recovery-detail").textContent = t(
                    "partialRecoveryDetail",
                    [String(state.recoverablePrefix), String(state.chunkCount)],
                );
                el("partial-recovery-check").checked = false;
                el("save-prefix").disabled = true;
            }
            break;
        default:
            await renderIdle(version);
            break;
    }
}

el("stop").addEventListener("click", async () => {
    await recordingFolder.saved();
    await sendMessage({ type: "stop-recording", reason: "user" });
});

el("retry").addEventListener("click", async () => {
    const result = await sendMessage({ type: "retry-upload" });
    if (result?.ok === false) {
        el("error-text").textContent = result.error ?? t("recoveryUnavailable");
    }
});

el("partial-recovery-check").addEventListener("change", (event) => {
    el("save-prefix").disabled = !event.target.checked;
});

el("save-prefix").addEventListener("click", async () => {
    if (!el("partial-recovery-check").checked || !currentRecoverablePrefix) return;
    const response = await sendMessage({
        type: "save-prefix",
        chunkCount: currentRecoverablePrefix,
    });
    if (response?.ok === false) el("error-text").textContent = response.error;
});

el("discard").addEventListener("click", async () => {
    await sendMessage({ type: "discard-session", sessionId: currentSessionId });
});

for (const id of ["open-options", "go-options"]) {
    el(id).addEventListener("click", () => {
        chrome.runtime.openOptionsPage();
    });
}

el("allow-mic").addEventListener("click", async () => {
    await chrome.tabs.create({
        url: chrome.runtime.getURL("options/options.html?microphone=1"),
    });
    window.close();
});

el("dismiss-mic").addEventListener("click", async () => {
    await saveSettings({ micReminderDismissed: true });
    await renderMicrophoneWarning(currentState);
    await sendMessage({ type: "reevaluate-tabs" });
});

const renderMeetingPromptOffer = bindMeetingPromptOffer({
    offer: el("meeting-prompt-offer"), enable: el("enable-meeting-prompt"),
    dismiss: el("dismiss-meeting-prompt"), status: el("meeting-prompt-offer-status"),
});

// ---- Live updates --------------------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "state") {
        void render(message.state);
    } else if (message?.type === "levels") {
        el("mic-bar").style.width = dbToWidth(message.micDb);
        el("sys-bar").style.width = dbToWidth(message.systemDb);
    }
});

// Initial paint.
(async () => {
    void sendMessage({ type: "reevaluate-tabs" }).catch(() => {});
    currentTab = await activeTab();
    currentPlatform = currentTab?.url
        ? detectMeetingPlatform(currentTab.url)
        : null;
    const response = await sendMessage({ type: "get-state" });
    await render(response?.state ?? { state: STATE.idle });
})();
