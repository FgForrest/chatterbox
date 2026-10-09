// Riffado Meeting Recorder service worker.
//
// Owns the recording lifecycle: starts capture (tab audio for a detected
// meeting tab, screen picker otherwise), creates the server session, drives
// the offscreen document, pumps buffered chunks to the server, completes the
// session and saves a local copy. Also owns auto mode: detecting meeting tabs,
// arming the toolbar icon for one-click start, nudging, and auto-stop.
//
// Capture itself lives in the offscreen document; binary never crosses the
// messaging boundary -- chunks travel through OPFS, which both contexts share.
// Every piece of per-tab state lives in chrome.storage.session, never in
// module scope: MV3 suspends this worker between events.

import {
    abortSession,
    completeSession,
    createSession,
    getSession,
    sha256Hex,
    uploadChunk,
} from "./lib/api.js";
import {
    assembleBlob,
    createLocalSession,
    deleteLocalSession,
    listChunkIndices,
    listLocalSessions,
    readChunk,
    readLocalMeta,
    totalBufferedBytes,
} from "./lib/chunk-store.js";
import {
    ALARMS,
    CHANNEL_LAYOUT_MIXED,
    CHANNEL_LAYOUT_SPLIT,
    MESSAGES,
    SESSION_MIME_TYPE,
    STATE,
} from "./lib/constants.js";
import {
    originOf,
    refreshServerConfig,
    registerPairingScript,
    storePairing,
} from "./lib/pairing.js";
import { detectMeetingPlatform, platformById } from "./lib/platforms.js";
import {
    anyPlatformAuto,
    effectivePlatformModes,
    effectiveQuietSeconds,
    getSettings,
    isPaired,
} from "./lib/settings.js";

const STATE_KEY = "recordingState";
const ARMED_KEY = "armedTabs";
const OFFSCREEN_URL = "offscreen/offscreen.html";
const POPUP_URL = "popup/popup.html";
const DEFAULT_TITLE = "Riffado Meeting Recorder";
const OPFS_WARN_BYTES = 1024 * 1024 * 1024; // 1 GiB of unsent audio.
const NUDGE_PREFIX = "nudge:";

/** Ignore errors from chrome.action calls on tabs that just closed. */
async function safe(promise) {
    try {
        return await promise;
    } catch {
        return undefined;
    }
}

// ---- Recording state ---------------------------------------------------

/**
 * @typedef {Object} RecordingState
 * @property {string} state
 * @property {string|null} sessionId
 * @property {string|null} startedAt
 * @property {string|null} platformHint
 * @property {number|null} tabId
 * @property {boolean} autoStarted     started by the auto-mode click or shortcut
 * @property {number} chunkCount       total chunks the recorder produced (once stopped)
 * @property {boolean} stopped         recorder finished; no more chunks arrive
 * @property {string} stopReason
 * @property {number[]} uploaded       committed chunk indices
 * @property {string|null} jobId
 * @property {string|null} error
 * @property {{micDb:number, systemDb:number}} levels
 */

const IDLE_STATE = Object.freeze({
    state: STATE.idle,
    sessionId: null,
    startedAt: null,
    platformHint: null,
    tabId: null,
    autoStarted: false,
    chunkCount: 0,
    stopped: false,
    stopReason: "user",
    uploaded: [],
    jobId: null,
    error: null,
    levels: { micDb: -100, systemDb: -100 },
});

/** @returns {Promise<RecordingState>} */
async function getState() {
    const raw = await chrome.storage.session.get(STATE_KEY);
    return raw[STATE_KEY] ?? { ...IDLE_STATE };
}

async function setState(patch) {
    const current = await getState();
    const next = { ...current, ...patch };
    await chrome.storage.session.set({ [STATE_KEY]: next });
    chrome.runtime.sendMessage({ type: "state", state: next }).catch(() => {});
    await updateRecordingBadge(next);
    return next;
}

async function resetState() {
    const previous = await getState();
    await chrome.storage.session.remove(STATE_KEY);
    const next = await getState();
    chrome.runtime.sendMessage({ type: "state", state: next }).catch(() => {});
    await updateRecordingBadge(next);
    // Clear the recording badge on the tab that was recording, then let the
    // evaluation put the armed badge back if the tab is still in a meeting.
    if (previous.tabId != null) {
        await safe(chrome.action.setBadgeText({ tabId: previous.tabId, text: "" }));
        await safe(chrome.action.setTitle({ tabId: previous.tabId, title: DEFAULT_TITLE }));
        await reevaluateTab(previous.tabId);
    }
}

async function updateRecordingBadge(state) {
    const recording =
        state.state === STATE.recording || state.state === STATE.finalizing;
    if (state.tabId != null) {
        await safe(
            chrome.action.setBadgeText({
                tabId: state.tabId,
                text: recording ? "REC" : "",
            }),
        );
        if (recording) {
            await safe(
                chrome.action.setBadgeBackgroundColor({
                    tabId: state.tabId,
                    color: "#d33",
                }),
            );
        }
    }
}

// ---- Offscreen document ------------------------------------------------

async function hasOffscreen() {
    const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    return contexts.length > 0;
}

async function ensureOffscreen() {
    if (await hasOffscreen()) return;
    await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["USER_MEDIA"],
        justification:
            "Capture microphone and meeting audio to record the meeting.",
    });
}

async function closeOffscreen() {
    if (await hasOffscreen()) {
        await chrome.offscreen.closeDocument().catch(() => {});
    }
}

function messageOffscreen(type, payload) {
    return chrome.runtime.sendMessage({ target: "offscreen", type, payload });
}

// ---- Capture sources ---------------------------------------------------

function chooseDesktopMedia(tab) {
    return new Promise((resolve) => {
        try {
            chrome.desktopCapture.chooseDesktopMedia(
                ["screen", "audio"],
                tab ?? undefined,
                (streamId) => {
                    resolve({
                        streamId:
                            chrome.runtime.lastError || !streamId
                                ? null
                                : streamId,
                    });
                },
            );
        } catch {
            resolve({ streamId: null });
        }
    });
}

/** A media stream id for one tab's own audio output. */
function getTabMediaStreamId(tabId) {
    return new Promise((resolve) => {
        try {
            chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
                resolve(chrome.runtime.lastError || !id ? null : id);
            });
        } catch {
            resolve(null);
        }
    });
}

// ---- Start / stop ------------------------------------------------------

/**
 * @param {{tabId?: number, platformHint?: string, auto?: boolean, noticeAcknowledgedAt?: string}} input
 */
async function startRecording({
    tabId,
    platformHint,
    auto = false,
    noticeAcknowledgedAt,
}) {
    const current = await getState();
    if (current.state !== STATE.idle && current.state !== STATE.error) {
        throw new Error("A recording is already in progress");
    }
    if (!(await isPaired())) {
        throw new Error(
            "Connect the extension to Riffado first (open the options page).",
        );
    }

    await setState({ state: STATE.awaitingPicker, error: null });

    // Hybrid capture: a recognized meeting tab is captured directly (no
    // picker, no "share system audio" step). Anything else falls back to the
    // screen + system-audio picker, shown up front so a cancel costs nothing.
    // A tab-capture stream id is short-lived, so it is minted just before the
    // offscreen document consumes it, below.
    const useTab = typeof tabId === "number" && Boolean(platformHint);
    let captureMode = useTab ? "tab" : "desktop";
    let streamId = null;
    if (!useTab) {
        let tab = null;
        if (typeof tabId === "number") {
            tab = await chrome.tabs.get(tabId).catch(() => null);
        }
        const picked = await chooseDesktopMedia(tab);
        streamId = picked.streamId;
        if (!streamId) {
            await resetState();
            return { cancelled: true };
        }
    }

    const settings = await getSettings();
    const auth = { serverUrl: settings.serverUrl, apiKey: settings.apiKey };
    const startedAt = new Date().toISOString();
    const channelLayout =
        settings.channelMode === "split"
            ? CHANNEL_LAYOUT_SPLIT
            : CHANNEL_LAYOUT_MIXED;

    let session;
    try {
        session = await createSession(auth, {
            mimeType: SESSION_MIME_TYPE,
            channelLayout,
            startedAt,
            platformHint: platformHint ?? undefined,
            clientVersion: chrome.runtime.getManifest().version,
            timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
            noticeAcknowledgedAt: noticeAcknowledgedAt ?? startedAt,
        });
    } catch (error) {
        await setState({
            state: STATE.error,
            error: error?.message ?? String(error),
        });
        throw error;
    }

    await createLocalSession(session.id, {
        serverSessionId: session.id,
        startedAt,
        platformHint: platformHint ?? null,
        done: false,
    });

    await setState({
        state: STATE.recording,
        sessionId: session.id,
        startedAt,
        platformHint: platformHint ?? null,
        tabId: typeof tabId === "number" ? tabId : null,
        autoStarted: auto,
        chunkCount: 0,
        stopped: false,
        stopReason: "user",
        uploaded: [],
        jobId: null,
    });

    if (typeof tabId === "number") {
        await chrome.notifications.clear(`${NUDGE_PREFIX}${tabId}`).catch(() => {});
        await safe(
            chrome.action.setTitle({
                tabId,
                title: "Recording. Click to stop and save.",
            }),
        );
    }

    await ensureOffscreen();

    if (useTab) {
        streamId = await getTabMediaStreamId(tabId);
        if (!streamId) {
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            const picked = await chooseDesktopMedia(tab);
            streamId = picked.streamId;
            captureMode = "desktop";
            if (!streamId) {
                await closeOffscreen();
                await discardSession(session.id);
                return { cancelled: true };
            }
        }
    }

    const response = await messageOffscreen("start", {
        sessionId: session.id,
        captureMode,
        channelMode: settings.channelMode,
        streamId,
        microphoneId: settings.microphoneId,
    });
    if (!response?.ok) {
        const message = response?.error ?? "Could not start audio capture";
        await setState({ state: STATE.error, error: message });
        await closeOffscreen();
        throw new Error(message);
    }

    return { sessionId: session.id };
}

async function stopRecording(reason = "user") {
    const state = await getState();
    if (state.state !== STATE.recording) return;
    if (state.tabId != null) {
        await chrome.alarms.clear(`${ALARMS.quietPrefix}${state.tabId}`);
    }
    await setState({ stopReason: reason });
    await messageOffscreen("stop").catch(() => {});
    // The offscreen 'recording-stopped' message carries the final chunk
    // count and drives finalization from there.
}

// ---- Upload pump -------------------------------------------------------

let pumping = false;

async function pumpUploads() {
    if (pumping) return;
    pumping = true;
    try {
        for (;;) {
            const state = await getState();
            if (!state.sessionId) break;
            if (
                state.state !== STATE.recording &&
                state.state !== STATE.finalizing
            ) {
                break;
            }
            const settings = await getSettings();
            const auth = {
                serverUrl: settings.serverUrl,
                apiKey: settings.apiKey,
            };

            const stored = await listChunkIndices(state.sessionId);
            const uploaded = new Set(state.uploaded);
            const pending = stored.filter((index) => !uploaded.has(index));

            if (pending.length === 0) {
                if (state.stopped) await finalize();
                break;
            }

            let progressed = false;
            for (const index of pending) {
                try {
                    const blob = await readChunk(state.sessionId, index);
                    const hash = await sha256Hex(blob);
                    await uploadChunk(auth, state.sessionId, index, blob, hash);
                    const now = await getState();
                    await setState({
                        uploaded: [...new Set([...now.uploaded, index])],
                    });
                    progressed = true;
                } catch (error) {
                    if (error?.status === 401 || error?.status === 403) {
                        await setState({
                            error: "The recorder key was rejected. Reconnect in options.",
                        });
                    }
                    break;
                }
            }
            if (!progressed) break;
        }
    } finally {
        pumping = false;
    }
}

async function finalize() {
    const state = await getState();
    if (!state.sessionId || !state.stopped) return;
    if (state.state === STATE.finalizing && state.jobId) return;

    await setState({ state: STATE.finalizing });
    const settings = await getSettings();
    const auth = { serverUrl: settings.serverUrl, apiKey: settings.apiKey };

    try {
        const result = await completeSession(auth, state.sessionId, {
            chunkCount: state.chunkCount,
            endedAt: new Date().toISOString(),
            stopReason: state.stopReason,
        });
        await setState({ jobId: result.job_id ?? null });

        await maybeSaveLocalCopy(state.sessionId);

        const meta = await readLocalMeta(state.sessionId);
        if (meta) {
            await createLocalSession(state.sessionId, { ...meta, done: true });
        }
        await deleteLocalSession(state.sessionId);

        await notify(
            "Recording sent",
            "Your meeting is uploading to Riffado and will be transcribed shortly.",
        );
        await resetState();
    } catch (error) {
        await setState({
            state: STATE.error,
            error:
                error?.message ??
                "Could not finalize the recording. Your local copy is kept.",
        });
    }
}

// ---- Local copy --------------------------------------------------------

// MV3 service workers do not expose URL.createObjectURL, so the local copy is
// handed to the downloads API as a data: URL built here. Base64 inflates the
// payload ~33%, so past this size the local copy is skipped (the server has
// the recording) rather than risk a failed or memory-heavy encode.
const MAX_LOCAL_COPY_BYTES = 200 * 1024 * 1024;

async function blobToDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode(...bytes.subarray(i, i + step));
    }
    return `data:${blob.type || "audio/webm"};base64,${btoa(binary)}`;
}

async function maybeSaveLocalCopy(sessionId) {
    const settings = await getSettings();
    if (settings.localCopyPolicy === "never") return;

    const meta = await readLocalMeta(sessionId);
    const blob = await assembleBlob(sessionId, "audio/webm");
    if (blob.size === 0) return;

    if (blob.size > MAX_LOCAL_COPY_BYTES) {
        await notify(
            "Local copy skipped",
            "The recording is large and was uploaded to Riffado, but not saved locally.",
        );
        return;
    }

    const started = meta?.startedAt ? new Date(meta.startedAt) : new Date();
    const stamp = started.toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const folder = settings.downloadFolder.replace(/[\\/]+$/, "");
    const filename = `${folder}/meeting-${stamp}.webm`;

    try {
        const url = await blobToDataUrl(blob);
        await chrome.downloads.download({
            url,
            filename,
            saveAs: settings.localCopyPolicy === "ask",
            conflictAction: "uniquify",
        });
    } catch (error) {
        console.error("[recorder] local copy failed:", error);
    }
}

// ---- Notifications -----------------------------------------------------

async function notify(title, message, options = {}) {
    try {
        return await chrome.notifications.create(options.id ?? undefined, {
            type: "basic",
            iconUrl: "icons/icon-128.png",
            title,
            message,
            requireInteraction: options.requireInteraction ?? false,
        });
    } catch {
        return null;
    }
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
    if (!notificationId.startsWith(NUDGE_PREFIX)) return;
    chrome.notifications.clear(notificationId);
    const tabId = Number.parseInt(notificationId.slice(NUDGE_PREFIX.length), 10);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    // A notification click cannot start capture (Chrome requires the toolbar
    // click or shortcut), so bring the meeting tab forward and let the badge
    // do the asking.
    await safe(chrome.tabs.update(tabId, { active: true }));
    if (tab.windowId != null) {
        await safe(chrome.windows.update(tab.windowId, { focused: true }));
    }
});

// ---- Auto mode: arming -------------------------------------------------

/**
 * @typedef {Object} ArmedTab
 * @property {string} platformId
 * @property {"auto"|"prompt"} mode
 * @property {boolean} nudged
 */

/** @returns {Promise<Record<string, ArmedTab>>} */
async function getArmed() {
    const raw = await chrome.storage.session.get(ARMED_KEY);
    return raw[ARMED_KEY] ?? {};
}

async function setArmed(armed) {
    await chrome.storage.session.set({ [ARMED_KEY]: armed });
}

async function applyArmedUi(tabId, platform, mode) {
    // In auto mode the popup is disabled on this tab, so the toolbar click is
    // a direct invocation that unlocks tab capture (verified in Phase 0).
    await safe(
        chrome.action.setPopup({
            tabId,
            popup: mode === "auto" ? "" : POPUP_URL,
        }),
    );
    await safe(chrome.action.setBadgeText({ tabId, text: "REC?" }));
    await safe(chrome.action.setBadgeBackgroundColor({ tabId, color: "#d33" }));
    await safe(
        chrome.action.setTitle({
            tabId,
            title:
                mode === "auto"
                    ? `Click to record this ${platform.name} meeting with Riffado`
                    : `Riffado: ${platform.name} meeting detected`,
        }),
    );
}

async function arm(tab, platform, mode) {
    const armed = await getArmed();
    const existing = armed[tab.id];
    armed[tab.id] = {
        platformId: platform.id,
        mode,
        nudged: existing?.nudged ?? false,
    };
    await setArmed(armed);
    await applyArmedUi(tab.id, platform, mode);
    if (tab.audible && !armed[tab.id].nudged) {
        await nudge(tab.id, platform, mode);
    }
}

async function disarm(tabId) {
    const armed = await getArmed();
    if (!armed[tabId]) return;
    delete armed[tabId];
    await setArmed(armed);
    await chrome.notifications.clear(`${NUDGE_PREFIX}${tabId}`).catch(() => {});
    await safe(chrome.action.setPopup({ tabId, popup: POPUP_URL }));
    await safe(chrome.action.setBadgeText({ tabId, text: "" }));
    await safe(chrome.action.setTitle({ tabId, title: DEFAULT_TITLE }));
}

async function nudge(tabId, platform, mode) {
    const settings = await getSettings();
    if (!settings.nudgeEnabled) return;
    const armed = await getArmed();
    if (!armed[tabId] || armed[tabId].nudged) return;
    armed[tabId].nudged = true;
    await setArmed(armed);
    await notify(
        `${platform.name} meeting detected`,
        mode === "auto"
            ? "Click the Riffado icon or press the shortcut to record. Click here to go to the meeting."
            : "Click the Riffado icon to record this meeting.",
        { id: `${NUDGE_PREFIX}${tabId}`, requireInteraction: true },
    );
}

/**
 * Decide, for one tab, whether it should be armed and how. Idempotent, so it
 * is safe to call on every load, navigation and audible change.
 */
async function evaluateTab(tab) {
    if (!tab || tab.id == null) return;
    const platform = tab.url ? detectMeetingPlatform(tab.url) : null;
    const state = await getState();

    if (!platform) {
        await disarm(tab.id);
        if (
            state.state === STATE.recording &&
            state.tabId === tab.id &&
            state.autoStarted
        ) {
            await stopRecording("meeting-ended");
        }
        return;
    }

    if (!(await isPaired())) return;
    const settings = await getSettings();
    const mode = effectivePlatformModes(settings)[platform.id]?.mode ?? "off";
    if (mode === "off") {
        await disarm(tab.id);
        return;
    }

    // While recording this tab, leave the recording badge alone.
    if (state.state === STATE.recording && state.tabId === tab.id) return;

    // Arming is idempotent (it keeps the nudged flag), so re-apply it even
    // for a tab that is already armed: a recording that just ended, or a
    // worker restart, may have left the badge or popup state stale.
    await arm(tab, platform, mode);
}

async function reevaluateTab(tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) await evaluateTab(tab);
}

async function reevaluateAllTabs() {
    const tabs = await chrome.tabs.query({}).catch(() => []);
    for (const tab of tabs) await evaluateTab(tab);
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === "complete") {
        await evaluateTab(tab);
    }

    if (changeInfo.audible === true) {
        await chrome.alarms.clear(`${ALARMS.quietPrefix}${tabId}`);
        const armed = await getArmed();
        const entry = armed[tabId];
        if (entry && !entry.nudged) {
            const platform = platformById(entry.platformId);
            if (platform) await nudge(tabId, platform, entry.mode);
        }
    }

    if (changeInfo.audible === false) {
        const state = await getState();
        if (
            state.state === STATE.recording &&
            state.tabId === tabId &&
            state.autoStarted
        ) {
            // Never stop on the flag alone: it flickers with every pause in
            // speech. Start the quiet clock; any audible event clears it.
            const settings = await getSettings();
            await chrome.alarms.create(`${ALARMS.quietPrefix}${tabId}`, {
                delayInMinutes: Math.max(0.5, effectiveQuietSeconds(settings) / 60),
            });
        }
    }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
    await disarm(tabId);
    await chrome.alarms.clear(`${ALARMS.quietPrefix}${tabId}`);
    const state = await getState();
    if (state.state === STATE.recording && state.tabId === tabId) {
        await stopRecording("tab-closed");
    }
});

// Re-arm live when the user changes a platform mode or the server pushes new
// defaults, without waiting for the next navigation.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.platformModes || changes.serverDefaults || changes.apiKey) {
        void reevaluateAllTabs();
    }
});

// ---- Auto mode: one-click start and shortcut -----------------------------

/**
 * Start from an invocation (toolbar click or shortcut) on `tab`. Requires the
 * one-time policy acknowledgement; without it the options page opens so the
 * user can confirm once.
 */
async function startFromInvocation(tab) {
    const state = await getState();
    if (state.state === STATE.recording && state.tabId === tab.id) {
        await stopRecording("user");
        return;
    }
    if (state.state === STATE.recording || state.state === STATE.finalizing) {
        await notify(
            "Already recording",
            "Stop the current recording before starting another.",
        );
        return;
    }

    const platform = tab.url ? detectMeetingPlatform(tab.url) : null;
    if (!platform) {
        chrome.runtime.openOptionsPage();
        return;
    }

    const settings = await getSettings();
    if (!settings.autoModeAcknowledgedAt) {
        await notify(
            "One-time confirmation needed",
            "Confirm the recording policy once in the extension options, then click again.",
        );
        chrome.runtime.openOptionsPage();
        return;
    }

    try {
        await startRecording({
            tabId: tab.id,
            platformHint: platform.id,
            auto: true,
            noticeAcknowledgedAt: settings.autoModeAcknowledgedAt,
        });
    } catch (error) {
        await notify("Could not start", error?.message ?? String(error));
    }
}

// Fires only on tabs where the popup is disabled, i.e. armed auto tabs.
chrome.action.onClicked.addListener((tab) => {
    void startFromInvocation(tab);
});

chrome.commands.onCommand.addListener(async (command) => {
    if (command !== "toggle-recording") return;
    const state = await getState();
    if (state.state === STATE.recording) {
        await stopRecording("user");
        return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await startFromInvocation(tab);
});

// ---- Alarms: auto-stop and config refresh --------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARMS.configRefresh) {
        await refreshServerConfig().catch(() => {});
        return;
    }
    if (alarm.name.startsWith(ALARMS.quietPrefix)) {
        const tabId = Number.parseInt(alarm.name.slice(ALARMS.quietPrefix.length), 10);
        const state = await getState();
        if (
            state.state !== STATE.recording ||
            state.tabId !== tabId ||
            !state.autoStarted
        ) {
            return;
        }
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab?.audible) return; // sound came back; a new quiet clock will start
        await stopRecording("auto-quiet");
        await notify(
            "Recording stopped",
            "The meeting went quiet, so the recording was saved.",
        );
    }
});

async function ensureConfigAlarm() {
    const existing = await chrome.alarms.get(ALARMS.configRefresh);
    if (!existing) {
        await chrome.alarms.create(ALARMS.configRefresh, {
            periodInMinutes: 24 * 60,
        });
    }
}

// ---- Pairing and presence ---------------------------------------------

async function pingStatus() {
    const settings = await getSettings();
    return {
        installed: true,
        version: chrome.runtime.getManifest().version,
        paired: Boolean(settings.serverUrl && settings.apiKey),
        pairedTo: settings.serverUrl ? originOf(settings.serverUrl) : null,
        autoMode: anyPlatformAuto(settings),
    };
}

/**
 * Accept a pairing only from the origin it names. `senderOrigin` is derived
 * from the sender's URL by Chrome, so it cannot be forged by the page.
 */
async function handlePairing(message, senderOrigin) {
    if (
        typeof message.serverUrl !== "string" ||
        typeof message.apiKey !== "string"
    ) {
        throw new Error("Pairing message missing server URL or key");
    }
    const serverOrigin = originOf(message.serverUrl);
    if (!serverOrigin || !senderOrigin || serverOrigin !== senderOrigin) {
        throw new Error("Pairing refused: the page origin does not match the server URL");
    }
    await storePairing({ serverUrl: serverOrigin, apiKey: message.apiKey });
    await registerPairingScript(serverOrigin);
    await notify(
        "Riffado connected",
        "The recorder is paired with your Riffado account.",
    );
    await reevaluateAllTabs();
    return { ok: true, paired: true, pairedTo: serverOrigin };
}

// From the Riffado web page on origins listed in externally_connectable.
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    const senderOrigin = originOf(sender.url ?? sender.origin ?? "");
    if (!senderOrigin || !message || typeof message.type !== "string") {
        sendResponse({ ok: false, error: "Unrecognized sender" });
        return false;
    }
    if (message.type === MESSAGES.ping) {
        pingStatus().then((status) =>
            sendResponse({ ...status, channel: "external" }),
        );
        return true;
    }
    if (message.type === MESSAGES.pair) {
        handlePairing(message, senderOrigin)
            .then(sendResponse)
            .catch((error) =>
                sendResponse({ ok: false, error: error?.message ?? String(error) }),
            );
        return true;
    }
    return false;
});

// ---- Internal messaging (popup, options, offscreen, content script) --------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target === "offscreen") return false;

    switch (message.type) {
        case "get-state":
            getState().then((state) => sendResponse({ state }));
            return true;

        case "get-armed":
            getArmed().then((armed) => sendResponse({ armed }));
            return true;

        case "start-recording":
            startRecording(message.payload ?? {})
                .then((result) => sendResponse({ ok: true, ...result }))
                .catch((error) =>
                    sendResponse({ ok: false, error: error?.message ?? String(error) }),
                );
            return true;

        case "stop-recording":
            stopRecording(message.reason ?? "user")
                .then(() => sendResponse({ ok: true }))
                .catch((error) =>
                    sendResponse({ ok: false, error: error?.message ?? String(error) }),
                );
            return true;

        case "retry-upload":
            pumpUploads()
                .then(() => sendResponse({ ok: true }))
                .catch(() => sendResponse({ ok: false }));
            return true;

        case "discard-session":
            discardSession(message.sessionId)
                .then(() => sendResponse({ ok: true }))
                .catch((error) =>
                    sendResponse({ ok: false, error: error?.message ?? String(error) }),
                );
            return true;

        case "refresh-config":
            refreshServerConfig()
                .then((stored) => sendResponse({ ok: true, stored }))
                .catch((error) =>
                    sendResponse({ ok: false, error: error?.message ?? String(error) }),
                );
            return true;

        case "reevaluate-tabs":
            reevaluateAllTabs().then(() => sendResponse({ ok: true }));
            return true;

        // From the pairing content script.
        case MESSAGES.ping:
            pingStatus().then((status) =>
                sendResponse({ ...status, channel: "content" }),
            );
            return true;

        case MESSAGES.pair:
            handlePairing(message, originOf(sender.url ?? ""))
                .then(sendResponse)
                .catch((error) =>
                    sendResponse({ ok: false, error: error?.message ?? String(error) }),
                );
            return true;

        // From the offscreen document.
        case "chunk-ready":
        case "recording-started":
            pumpUploads();
            return false;

        case "levels":
            setState({ levels: { micDb: message.micDb, systemDb: message.systemDb } });
            return false;

        case "recording-stopped":
            void handleRecordingStopped(message);
            return false;

        case "mic-unavailable":
            // Non-fatal: the meeting audio is recording without the mic.
            notify(
                "Recording without microphone",
                "Your microphone could not be opened, so only the meeting audio is being recorded.",
            );
            return false;

        case "stream-ended":
            stopRecording("stream-ended");
            return false;

        case "capture-error":
            setState({ state: STATE.error, error: message.message });
            closeOffscreen();
            return false;

        default:
            return false;
    }
});

async function handleRecordingStopped(message) {
    const state = await getState();
    if (state.sessionId !== message.sessionId) return;
    await closeOffscreen();

    if (!message.chunkCount || message.chunkCount < 1) {
        await discardSession(message.sessionId);
        await notify(
            "Nothing recorded",
            "No audio was captured, so nothing was saved. If you used the screen picker, make sure “Share system audio” was enabled.",
        );
        return;
    }

    await setState({ stopped: true, chunkCount: message.chunkCount });
    await pumpUploads();
}

async function discardSession(sessionId) {
    const settings = await getSettings();
    if (sessionId && settings.serverUrl && settings.apiKey) {
        await abortSession(
            { serverUrl: settings.serverUrl, apiKey: settings.apiKey },
            sessionId,
        ).catch(() => {});
    }
    if (sessionId) await deleteLocalSession(sessionId);
    await resetState();
}

// ---- Startup ---------------------------------------------------------------

async function reconcileOnStartup() {
    await ensureConfigAlarm();
    // Session storage is empty after a browser restart; re-arm open meetings.
    await reevaluateAllTabs();

    const settings = await getSettings();
    if (!settings.serverUrl || !settings.apiKey) return;
    const auth = { serverUrl: settings.serverUrl, apiKey: settings.apiKey };

    const state = await getState();
    if (state.state === STATE.recording && (await hasOffscreen())) {
        pumpUploads();
        return;
    }

    for (const sessionId of await listLocalSessions()) {
        const meta = await readLocalMeta(sessionId);
        if (!meta || meta.done) {
            await deleteLocalSession(sessionId);
            continue;
        }
        let session;
        try {
            session = await getSession(auth, sessionId);
        } catch {
            continue;
        }
        if (session.status !== "open") {
            await deleteLocalSession(sessionId);
            continue;
        }
        const stored = await listChunkIndices(sessionId);
        if (stored.length === 0) {
            // Interrupted before any audio was captured; there is nothing to
            // finalize, so abort it rather than completing an empty session.
            await abortSession(auth, sessionId).catch(() => {});
            await deleteLocalSession(sessionId);
            continue;
        }
        // Only resume into a recording state when nothing else is active.
        const live = await getState();
        if (live.state !== STATE.idle && live.state !== STATE.error) break;
        await chrome.storage.session.set({
            [STATE_KEY]: {
                ...live,
                state: STATE.recording,
                sessionId,
                startedAt: meta.startedAt ?? null,
                platformHint: meta.platformHint ?? null,
                chunkCount: stored.length,
                stopped: true,
                stopReason: "browser-closed",
                uploaded: [],
            },
        });
        await pumpUploads();
        break;
    }

    const buffered = await totalBufferedBytes();
    if (buffered > OPFS_WARN_BYTES) {
        await notify(
            "Unsent recordings",
            "Riffado has buffered recordings waiting to upload. Open the extension to retry.",
        );
    }
}

chrome.runtime.onStartup.addListener(() => {
    reconcileOnStartup().catch((error) =>
        console.error("[recorder] startup reconcile failed:", error),
    );
});
chrome.runtime.onInstalled.addListener(() => {
    reconcileOnStartup().catch(() => {});
});
