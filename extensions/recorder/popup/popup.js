// Popup UI: manual start with notice confirmation, live meters, error
// recovery, and the first-contact "Connect to this site" bootstrap for
// self-hosted Riffado instances.
//
// On tabs armed in auto mode the popup is disabled entirely (the toolbar
// click starts recording directly), so this UI only appears elsewhere.

import { STATE } from "../lib/constants.js";
import {
    grantHostAccess,
    injectPairingScript,
    originOf,
    registerPairingScript,
} from "../lib/pairing.js";
import { detectMeetingPlatform } from "../lib/platforms.js";
import {
    effectiveNoticeText,
    effectivePlatformModes,
    getSettings,
    isPaired,
} from "../lib/settings.js";

const views = {
    connect: document.getElementById("view-connect"),
    unpaired: document.getElementById("view-unpaired"),
    idle: document.getElementById("view-idle"),
    notice: document.getElementById("view-notice"),
    recording: document.getElementById("view-recording"),
    finalizing: document.getElementById("view-finalizing"),
    error: document.getElementById("view-error"),
};

const el = (id) => document.getElementById(id);

let elapsedTimer;
let currentSessionId = null;
let currentTab = null;
let currentPlatform = null;

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

// ---- Unpaired: connect to the current site ------------------------------

async function renderUnpaired() {
    const origin = currentTab?.url ? originOf(currentTab.url) : null;
    const isMeeting = currentTab?.url
        ? Boolean(detectMeetingPlatform(currentTab.url))
        : false;
    if (origin && !isMeeting) {
        el("connect-origin").textContent = `Connect to ${origin}`;
        el("connect-status").textContent = "";
        show("connect");
    } else {
        show("unpaired");
    }
}

el("connect-origin").addEventListener("click", async () => {
    const origin = currentTab?.url ? originOf(currentTab.url) : null;
    if (!origin || !currentTab) return;
    const status = el("connect-status");
    status.textContent = "Requesting access…";
    // This click is the user gesture Chrome requires for a host grant.
    const granted = await grantHostAccess(origin);
    if (!granted) {
        status.textContent =
            "Access was not granted. The extension cannot reach this server without it.";
        return;
    }
    await registerPairingScript(origin);
    await injectPairingScript(currentTab.id);
    status.textContent =
        "Connected to this site. Now click “Set up recorder” on the Riffado page.";
    setTimeout(() => window.close(), 1800);
});

el("connect-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
});

// ---- Idle / manual start ------------------------------------------------

async function renderIdle() {
    const settings = await getSettings();
    const hint = el("idle-hint");
    const autoHint = el("auto-hint");
    autoHint.hidden = true;
    el("picker-hint").hidden = true;

    if (currentPlatform) {
        hint.textContent = `Record this ${currentPlatform.name} meeting.`;
        el("start").textContent = "Record meeting";
        const mode = effectivePlatformModes(settings)[currentPlatform.id]?.mode;
        if (mode === "off") {
            autoHint.hidden = false;
            autoHint.textContent = `Tip: turn on automatic recording for ${currentPlatform.name} in Options, and the icon will offer to record with one click.`;
        }
    } else {
        hint.textContent =
            "No meeting detected in this tab. Record via the screen picker (works for native Zoom or Teams apps).";
        el("start").textContent = "Record via screen picker";
    }
    show("idle");
}

el("start").addEventListener("click", async () => {
    const settings = await getSettings();
    el("notice-text").textContent = effectiveNoticeText(settings);
    el("notice-ack").checked = false;
    el("notice-confirm").disabled = true;
    el("picker-hint").hidden = Boolean(currentPlatform);
    show("notice");
});

el("notice-ack").addEventListener("change", (event) => {
    el("notice-confirm").disabled = !event.target.checked;
});

el("notice-cancel").addEventListener("click", () => {
    void renderIdle();
});

el("notice-confirm").addEventListener("click", async () => {
    const response = await sendMessage({
        type: "start-recording",
        payload: {
            tabId: currentTab?.id,
            platformHint: currentPlatform?.id ?? undefined,
            noticeAcknowledgedAt: new Date().toISOString(),
        },
    });
    if (response && response.ok === false) {
        el("error-text").textContent = response.error;
        show("error");
    } else {
        window.close();
    }
});

// ---- Recording / finalizing / error --------------------------------------

function renderUploadStatus(state, elementId = "upload-status") {
    const node = el(elementId);
    if (!node) return;
    const uploaded = state.uploaded?.length ?? 0;
    node.textContent = state.stopped
        ? `Uploaded ${uploaded} of ${state.chunkCount} segments`
        : `${uploaded} segment(s) uploaded`;
}

async function render(state) {
    currentSessionId = state.sessionId;
    if (elapsedTimer) {
        clearInterval(elapsedTimer);
        elapsedTimer = undefined;
    }

    if (!(await isPaired())) {
        await renderUnpaired();
        return;
    }

    switch (state.state) {
        case STATE.recording: {
            show("recording");
            const tick = () => {
                el("elapsed").textContent = formatElapsed(state.startedAt);
            };
            tick();
            elapsedTimer = setInterval(tick, 1000);
            renderUploadStatus(state);
            break;
        }
        case STATE.finalizing:
            show("finalizing");
            renderUploadStatus(state, "finalizing-status");
            break;
        case STATE.awaitingPicker:
            show("idle");
            el("idle-hint").textContent = "Waiting for you to choose a screen…";
            break;
        case STATE.error:
            show("error");
            el("error-text").textContent = state.error ?? "Something went wrong.";
            break;
        default:
            await renderIdle();
            break;
    }
}

el("stop").addEventListener("click", async () => {
    await sendMessage({ type: "stop-recording", reason: "user" });
});

el("retry").addEventListener("click", async () => {
    await sendMessage({ type: "retry-upload" });
});

el("discard").addEventListener("click", async () => {
    await sendMessage({ type: "discard-session", sessionId: currentSessionId });
});

for (const id of ["open-options", "go-options"]) {
    el(id).addEventListener("click", () => {
        chrome.runtime.openOptionsPage();
    });
}

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
    currentTab = await activeTab();
    currentPlatform = currentTab?.url
        ? detectMeetingPlatform(currentTab.url)
        : null;
    const response = await sendMessage({ type: "get-state" });
    await render(response?.state ?? { state: STATE.idle });
})();
