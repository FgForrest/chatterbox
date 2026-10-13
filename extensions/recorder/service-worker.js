// Chatterbox Meeting Recorder service worker.
//
// Owns the recording lifecycle: starts capture (tab audio for a detected
// meeting tab, screen picker otherwise), creates the server session, drives
// the offscreen document, pumps buffered chunks to the server, and completes
// the session. Also owns auto mode: detecting meeting tabs,
// arming the toolbar icon for one-click start, nudging, and auto-stop.
//
// Capture lives in the offscreen document for tabs and in a persistent
// extension window for desktop audio. Chunks travel through shared OPFS.
// Every piece of per-tab state lives in chrome.storage.session, never in
// module scope: MV3 suspends this worker between events.

import {
    abortSession,
    completeSession,
    createSession,
    getSession,
    recoverSession,
    sha256Hex,
    uploadChunk,
} from "./lib/api.js";
import {
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
import { t } from "./lib/i18n.js";
import { getInstallationId, originOf, refreshServerConfig } from "./lib/pairing.js";
import { queuePairing } from "./lib/pairing-request.js";
import { detectMeetingPlatform, platformById } from "./lib/platforms.js";
import { canPumpUploads } from "./lib/upload-state.js";
import { readToken } from "./lib/token-vault.js";
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
const DEFAULT_TITLE = t("extensionName");
const OPFS_WARN_BYTES = 1024 * 1024 * 1024; // 1 GiB of unsent audio.
const NUDGE_PREFIX = "nudge:";
const COMPLETION_PREFIX = "completed:";
const COMPLETION_DISPLAY_MS = 2400;

chrome.storage.local
    .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .catch((error) => console.warn("[recorder] storage access level:", error));

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
    blocked: false,
    recoverablePrefix: null,
    jobId: null,
    recordingUrl: null,
    partial: false,
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

async function openDesktopRecorder(input) {
    const requestId = crypto.randomUUID();
    await setState({
        state: STATE.awaitingPicker,
        captureMode: "desktop",
        pickerRequestId: requestId,
        captureWindowId: null,
        tabId: input.tabId ?? null,
        platformHint: input.platformHint ?? null,
        autoStarted: input.auto ?? false,
        noticeAcknowledgedAt: input.noticeAcknowledgedAt ?? null,
        error: null,
    });
    try {
        const url = new URL(chrome.runtime.getURL("picker/picker.html"));
        url.searchParams.set("requestId", requestId);
        const pickerWindow = await chrome.windows.create({
            url: url.href,
            type: "popup",
            focused: true,
            width: 430,
            height: 360,
        });
        if (pickerWindow?.id == null) throw new Error(t("couldNotCapture"));
        await setState({ captureWindowId: pickerWindow.id });
    } catch (error) {
        await setState({ state: STATE.error, error: error?.message ?? String(error) });
        throw error;
    }
    return { pending: true };
}

chrome.windows.onRemoved.addListener((windowId) => {
    void handleDesktopWindowClosed(windowId);
});

async function handleDesktopWindowClosed(windowId) {
    const state = await getState();
    if (state.captureWindowId !== windowId) return;
    if (state.state === STATE.awaitingPicker) {
        await resetState();
        return;
    }
    if (
        (state.state !== STATE.recording && state.state !== STATE.error) ||
        state.stopped ||
        !state.sessionId
    ) return;
    const stored = await listChunkIndices(state.bufferId ?? state.sessionId);
    if (stored.length === 0) {
        await discardSession(state.sessionId);
        return;
    }
    await setState({
        stopped: true,
        stopReason: state.stopReason === "error" ? "error" : "stream-ended",
        chunkCount: Math.max(...stored) + 1,
        captureWindowId: null,
    });
    await pumpUploads();
}

async function reconcileDesktopWindow() {
    const state = await getState();
    if (state.captureMode !== "desktop" || state.captureWindowId == null) return;
    if (
        state.state !== STATE.awaitingPicker &&
        state.state !== STATE.recording &&
        state.state !== STATE.error
    ) return;
    const window = await chrome.windows.get(state.captureWindowId).catch(() => null);
    if (!window) await handleDesktopWindowClosed(state.captureWindowId);
}

function messageDesktop(type, requestId, payload) {
    return chrome.runtime.sendMessage({
        target: "desktop-recorder",
        type,
        requestId,
        payload,
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

let starting = false;

/**
 * @param {{tabId?: number, platformHint?: string, auto?: boolean, noticeAcknowledgedAt?: string}} input
 */
async function startRecording(input) {
    if (starting) throw new Error(t("alreadyInProgress"));
    starting = true;
    try {
        return await startRecordingLocked(input);
    } catch (error) {
        if ((await getState()).state === STATE.awaitingPicker) {
            await setState({
                state: STATE.error,
                error: error?.message ?? String(error),
            });
        }
        throw error;
    } finally {
        starting = false;
    }
}

async function startRecordingLocked({
    tabId,
    platformHint,
    auto = false,
    noticeAcknowledgedAt,
}) {
    const current = await getState();
    if (current.state !== STATE.idle && current.state !== STATE.error) {
        throw new Error(t("alreadyInProgress"));
    }
    if (current.sessionId) throw new Error(t("unsentRecordingsBody"));
    if (!(await isPaired())) {
        throw new Error(t("connectFirst"));
    }
    if (!(await getSettings()).dataUseAcknowledgedAt) {
        throw new Error(t("dataUseRequired"));
    }
    const apiKey = await readToken();

    await setState({ state: STATE.awaitingPicker, error: null });

    const useTab = typeof tabId === "number" && Boolean(platformHint);
    if (!useTab) {
        return openDesktopRecorder({ tabId, platformHint, auto, noticeAcknowledgedAt });
    }

    return startCapturedRecording({
        tabId,
        platformHint,
        auto,
        noticeAcknowledgedAt,
        captureMode: "tab",
        apiKey,
    });
}

async function startCapturedRecording({
    tabId,
    platformHint,
    auto = false,
    noticeAcknowledgedAt,
    captureMode,
    captureWindowId = null,
    pickerRequestId = null,
    apiKey,
}) {
    const settings = await getSettings();
    if (settings.serverDefaults?.encryptedRecordingProtocol !== 1) {
        await setState({ state: STATE.error, error: t("encryptedServerRequired") });
        throw new Error(t("encryptedServerRequired"));
    }
    const auth = { serverUrl: settings.serverUrl, apiKey: apiKey ?? await readToken() };
    const startedAt = new Date().toISOString();
    const clientRecordingId = crypto.randomUUID();
    const channelLayout =
        settings.channelMode === "split"
            ? CHANNEL_LAYOUT_SPLIT
            : CHANNEL_LAYOUT_MIXED;

    let session;
    try {
        session = await createSession(auth, {
            clientRecordingId,
            mimeType: SESSION_MIME_TYPE,
            channelLayout,
            startedAt,
            platformHint: platformHint ?? undefined,
            clientVersion: chrome.runtime.getManifest().version,
            timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
            noticeAcknowledgedAt: noticeAcknowledgedAt ?? startedAt,
        });
    } catch (error) {
        const current = await getState();
        if (
            captureMode === "tab" ||
            (current.state === STATE.awaitingPicker &&
                current.pickerRequestId === pickerRequestId)
        ) {
            await setState({
                state: STATE.error,
                error: error?.message ?? String(error),
            });
        }
        throw error;
    }

    try {
        if (session.encryption?.protocol !== 1 || !session.encryption.key) {
            throw new Error(t("encryptedServerRequired"));
        }
        if (captureMode === "desktop") {
            const current = await getState();
            const window = await chrome.windows.get(captureWindowId).catch(() => null);
            if (
                current.state !== STATE.awaitingPicker ||
                current.pickerRequestId !== pickerRequestId ||
                !window
            ) {
                await abortSession(auth, session.id).catch(() => {});
                return { cancelled: true };
            }
        }

        await createLocalSession(session.id, {
            serverSessionId: session.id,
            clientRecordingId,
            serverUrl: settings.serverUrl,
            keyExpiresAt: session.encryption.expires_at,
            startedAt,
            platformHint: platformHint ?? null,
            done: false,
        });

        await setState({
            state: STATE.recording,
            sessionId: session.id,
            bufferId: session.id,
            startedAt,
            platformHint: platformHint ?? null,
            tabId: typeof tabId === "number" ? tabId : null,
            autoStarted: auto,
            chunkCount: 0,
            stopped: false,
            stopReason: "user",
            uploaded: [],
            jobId: null,
            captureMode,
            captureWindowId,
            pickerRequestId,
        });

        if (typeof tabId === "number") {
            await chrome.notifications.clear(`${NUDGE_PREFIX}${tabId}`).catch(() => {});
            await safe(
                chrome.action.setTitle({
                    tabId,
                    title: t("recordingTitle"),
                }),
            );
        }

        let response;
        if (captureMode === "tab") {
            await ensureOffscreen();
            const streamId = await getTabMediaStreamId(tabId);
            if (!streamId) {
                await closeOffscreen();
                await discardSession(session.id);
                return openDesktopRecorder({ tabId, platformHint, auto, noticeAcknowledgedAt });
            }
            response = await messageOffscreen("start", {
                sessionId: session.id,
                clientRecordingId,
                captureKey: session.encryption.key,
                captureMode,
                channelMode: settings.channelMode,
                streamId,
                microphoneId: settings.microphoneId,
            });
        } else {
            const current = await getState();
            if (current.captureWindowId !== captureWindowId) {
                throw new Error(t("couldNotCapture"));
            }
            response = await messageDesktop("start", pickerRequestId, {
                sessionId: session.id,
                clientRecordingId,
                captureKey: session.encryption.key,
                captureMode,
                channelMode: settings.channelMode,
                microphoneId: settings.microphoneId,
            });
        }
        if (!response?.ok) {
            throw new Error(response?.error ?? t("couldNotCapture"));
        }

        return { sessionId: session.id };
    } catch (error) {
        if (captureMode === "tab") await closeOffscreen().catch(() => {});
        if (captureMode === "desktop") {
            await chrome.windows.remove(captureWindowId).catch(() => {});
        }
        const state = await getState();
        if (state.sessionId === session.id && (await listChunkIndices(session.id)).length === 0) {
            await discardSession(session.id);
        } else if (state.sessionId === session.id) {
            await setState({
                state: STATE.error,
                sessionId: session.id,
                bufferId: session.id,
                stopped: true,
                blocked: true,
                error: error?.message ?? String(error),
            });
        }
        const latest = await getState();
        if (
            captureMode === "tab" ||
            latest.sessionId === session.id ||
            (latest.state === STATE.awaitingPicker &&
                latest.pickerRequestId === pickerRequestId)
        ) {
            await setState({ state: STATE.error, error: error?.message ?? String(error) });
        }
        throw error;
    }
}

async function stopRecording(reason = "user") {
    const state = await getState();
    if (state.state !== STATE.recording) return;
    if (state.tabId != null) {
        await chrome.alarms.clear(`${ALARMS.quietPrefix}${state.tabId}`);
    }
    await setState({ stopReason: reason });
    if (state.captureMode === "desktop") {
        await messageDesktop("stop", state.pickerRequestId).catch(() =>
            handleDesktopWindowClosed(state.captureWindowId),
        );
    } else {
        await messageOffscreen("stop").catch(() => {});
    }
    // The capture host reports the final chunk count after its last write.
}

// ---- Upload pump -------------------------------------------------------

let pumping = false;

async function pumpUploads() {
    if (pumping) return;
    pumping = true;
    try {
        for (;;) {
            const state = await getState();
            if (!canPumpUploads(state)) break;
            const settings = await getSettings();
            const auth = {
                serverUrl: settings.serverUrl,
                apiKey: await readToken(),
            };

            const bufferId = state.bufferId ?? state.sessionId;
            const meta = await readLocalMeta(bufferId);
            if (meta?.nextRetryAt && Date.parse(meta.nextRetryAt) > Date.now()) {
                await chrome.alarms.create(ALARMS.uploadRetry, {
                    when: Date.parse(meta.nextRetryAt),
                });
                break;
            }

            const stored = await listChunkIndices(bufferId);
            const uploaded = new Set(state.uploaded);
            const pending = stored.filter((index) => !uploaded.has(index));

            if (pending.length === 0) {
                if (state.stopped) {
                    const missing = Array.from(
                        { length: state.chunkCount },
                        (_, index) => index,
                    ).find((index) => !uploaded.has(index));
                    if (missing !== undefined) {
                        await setState({
                            state: STATE.error,
                            blocked: true,
                            recoverablePrefix: missing > 0 ? missing : null,
                            error: `Encrypted buffer is missing chunk ${missing}`,
                        });
                    } else {
                        await finalize();
                    }
                }
                break;
            }

            let progressed = false;
            for (const index of pending) {
                try {
                    const blob = await readChunk(state.bufferId ?? state.sessionId, index);
                    const hash = await sha256Hex(blob);
                    await uploadChunk(auth, state.sessionId, index, blob, hash);
                    const now = await getState();
                    await setState({
                        uploaded: [...new Set([...now.uploaded, index])],
                    });
                    if (meta?.nextRetryAt) {
                        await createLocalSession(bufferId, {
                            ...meta,
                            retryAttempt: 0,
                            nextRetryAt: null,
                        });
                    }
                    progressed = true;
                } catch (error) {
                    if (error?.status && ![429, 500, 502, 503, 504].includes(error.status)) {
                        await setState({
                            state: STATE.error,
                            blocked: true,
                            recoverablePrefix:
                                [409, 413, 422].includes(error.status) && index > 0
                                    ? index
                                    : null,
                            error: error?.message ?? t("keyRejected"),
                        });
                    } else {
                        await scheduleUploadRetry(state.bufferId ?? state.sessionId, error);
                    }
                    break;
                }
            }
            if (!progressed) break;
        }
    } catch (error) {
        await setState({
            state: STATE.error,
            blocked: true,
            error: error?.message ?? t("recoveryUnavailable"),
        });
    } finally {
        pumping = false;
    }
}

async function finalize(truncatedAtChunk = null) {
    const state = await getState();
    if (!state.sessionId || !state.stopped) return;
    if (state.state === STATE.finalizing && state.jobId) return;

    await setState({ state: STATE.finalizing });
    try {
        const settings = await getSettings();
        const auth = { serverUrl: settings.serverUrl, apiKey: await readToken() };
        const result = await completeSession(auth, state.sessionId, {
            chunkCount: state.chunkCount,
            ...(truncatedAtChunk ? { truncatedAtChunk } : {}),
            endedAt: new Date().toISOString(),
            stopReason: state.stopReason,
        });
        await setState({ jobId: result.job_id ?? null });

        await reconcileServerSession(state.sessionId, auth);
    } catch (error) {
        await setState({
            state: STATE.error,
            error:
                error?.message ??
                t("finalizeFailed"),
        });
    }
}

async function scheduleUploadRetry(sessionId, error) {
    const meta = await readLocalMeta(sessionId);
    if (!meta) return;
    const attempt = Math.min((meta.retryAttempt ?? 0) + 1, 10);
    const backoffSeconds = Math.min(3600, 5 * 2 ** (attempt - 1));
    const delaySeconds = Math.max(
        error?.retryAfterSeconds ?? 0,
        backoffSeconds * (0.75 + Math.random() * 0.5),
    );
    const nextRetryAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    await createLocalSession(sessionId, { ...meta, retryAttempt: attempt, nextRetryAt });
    await chrome.alarms.create(ALARMS.uploadRetry, {
        when: Date.parse(nextRetryAt),
    });
}

async function reconcileServerSession(sessionId, auth) {
    const remote = await getSession(auth, sessionId);
    if (remote.status === "completing") {
        await chrome.alarms.create(ALARMS.uploadRetry, { delayInMinutes: 1 });
        return;
    }
    if (remote.status === "completed") {
        if (!remote.recording_id) {
            await setState({
                state: STATE.error,
                error: "Server confirmed completion without a recording ID",
            });
            return;
        }
        const state = await getState();
        if (state.sessionId !== sessionId || state.state === STATE.completed) return;
        const url = new URL(
            `/recordings/${encodeURIComponent(remote.recording_id)}`,
            auth.serverUrl,
        ).href;
        await deleteLocalSession(state.bufferId ?? sessionId);
        await setState({
            state: STATE.completed,
            recordingUrl: url,
            partial: Boolean(remote.truncated_at_chunk),
        });
        await notify(
            t("recordingSent"),
            remote.truncated_at_chunk
                ? t("partialRecordingSent")
                : t("recordingSentBody"),
            { id: `${COMPLETION_PREFIX}${encodeURIComponent(url)}` },
        );
        await new Promise((resolve) => setTimeout(resolve, COMPLETION_DISPLAY_MS));
        const shown = await getState();
        if (shown.state !== STATE.completed || shown.sessionId !== sessionId) return;
        await resetState();
        await new Promise((resolve) => setTimeout(resolve, 400));
        if ((await getState()).state === STATE.idle) {
            await navigateToRecording(auth.serverUrl, url, state.tabId).catch(() => {});
        }
        return;
    }
    if (remote.status === "failed" || remote.status === "aborted") {
        await setState({
            state: STATE.error,
            blocked: true,
            error: remote.error ?? `Server session ${remote.status}`,
        });
    }
}

async function navigateToRecording(serverUrl, recordingUrl, preferredTabId) {
    const serverOrigin = originOf(serverUrl);
    const tabs = await chrome.tabs.query({}).catch(() => []);
    const matching = tabs.filter((tab) => tab.url && originOf(tab.url) === serverOrigin);
    const target =
        matching.find((tab) => tab.id === preferredTabId) ??
        matching.find((tab) => tab.active) ??
        matching.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
    if (target?.id != null) {
        const updated = await chrome.tabs
            .update(target.id, { url: recordingUrl, active: true })
            .then(() => true, () => false);
        if (updated) {
            if (target.windowId != null) {
                await chrome.windows.update(target.windowId, { focused: true }).catch(() => {});
            }
            return;
        }
    }
    await chrome.tabs.create({ url: recordingUrl, active: true });
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
    if (notificationId.startsWith(COMPLETION_PREFIX)) {
        const url = decodeURIComponent(
            notificationId.slice(COMPLETION_PREFIX.length),
        );
        await chrome.tabs.create({ url });
        return;
    }
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
                    ? t("autoActionTitle", platform.name)
                    : t("promptActionTitle", platform.name),
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
        t("meetingDetected", platform.name),
        mode === "auto"
            ? t("nudgeAuto")
            : t("nudgePrompt"),
        { id: `${NUDGE_PREFIX}${tabId}`, requireInteraction: true },
    );
}

/**
 * Decide, for one tab, whether it should be armed and how. Idempotent, so it
 * is safe to call on every load, navigation and audible change.
 */
async function evaluateTab(tab) {
    if (!tab || tab.id == null) return;
    const settings = await getSettings();
    if (!settings.dataUseAcknowledgedAt) {
        await disarm(tab.id);
        return;
    }
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
    if (!(await getSettings()).dataUseAcknowledgedAt) {
        for (const tabId of Object.keys(await getArmed())) {
            await disarm(Number(tabId));
        }
        return;
    }
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
    if (changes.platformModes || changes.serverDefaults || changes.encryptedApiKey || changes.dataUseAcknowledgedAt) {
        void reevaluateAllTabs();
    }
    if (changes.dataUseAcknowledgedAt?.newValue) {
        void reconcileOnStartup();
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
    if (
        state.state === STATE.awaitingPicker ||
        state.state === STATE.recording ||
        state.state === STATE.finalizing
    ) {
        await notify(
            t("alreadyRecording"),
            t("alreadyRecordingBody"),
        );
        return;
    }

    const settings = await getSettings();
    if (!settings.dataUseAcknowledgedAt) {
        chrome.runtime.openOptionsPage();
        return;
    }
    const platform = tab.url ? detectMeetingPlatform(tab.url) : null;
    if (!platform) {
        chrome.runtime.openOptionsPage();
        return;
    }

    if (!settings.autoModeAcknowledgedAt) {
        await notify(
            t("confirmationNeeded"),
            t("confirmationNeededBody"),
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
        await notify(t("couldNotStart"), error?.message ?? String(error));
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
    if (alarm.name === ALARMS.uploadRetry) {
        const state = await getState();
        if (state.sessionId && state.state === STATE.finalizing && state.jobId) {
            const settings = await getSettings();
            await reconcileServerSession(state.sessionId, {
                serverUrl: settings.serverUrl,
                apiKey: await readToken(),
            }).catch(() => chrome.alarms.create(ALARMS.uploadRetry, { delayInMinutes: 1 }));
        } else {
            await pumpUploads();
        }
        return;
    }
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
            t("recordingStopped"),
            t("recordingStoppedBody"),
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
    const consented = Boolean(settings.dataUseAcknowledgedAt);
    return {
        installed: true,
        version: chrome.runtime.getManifest().version,
        installationId: consented ? await getInstallationId() : undefined,
        paired: consented && Boolean(settings.serverUrl && settings.hasApiKey),
        pairedTo: consented && settings.serverUrl ? originOf(settings.serverUrl) : null,
        autoMode: consented && anyPlatformAuto(settings),
    };
}

// From the Chatterbox web page on origins listed in externally_connectable.
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    const senderOrigin = originOf(sender.url ?? sender.origin ?? "");
    if (!senderOrigin || !message || typeof message.type !== "string") {
        sendResponse({ ok: false, error: t("unrecognizedSender") });
        return false;
    }
    if (message.type === MESSAGES.ping) {
        pingStatus().then((status) =>
            sendResponse({ ...status, channel: "external" }),
        );
        return true;
    }
    if (message.type === MESSAGES.pair) {
        getSettings()
            .then((settings) => {
                if (!settings.dataUseAcknowledgedAt) {
                    return { ok: false, error: t("dataUseRequired") };
                }
                return queuePairing(message, senderOrigin);
            })
            .then(sendResponse)
            .catch((error) =>
                sendResponse({ ok: false, error: error?.message ?? String(error) }),
            );
        return true;
    }
    return false;
});

async function handleDesktopPickerMessage(message, sender) {
    const state = await getState();
    const expectedUrl = chrome.runtime.getURL("picker/picker.html");
    if (
        !sender.url?.startsWith(`${expectedUrl}?`) ||
        new URL(sender.url).searchParams.get("requestId") !== message.requestId ||
        state.state !== STATE.awaitingPicker ||
        state.pickerRequestId !== message.requestId ||
        state.captureWindowId == null ||
        (sender.tab && sender.tab.windowId !== state.captureWindowId)
    ) {
        return { ok: false, error: t("couldNotStart") };
    }
    if (message.type === "desktop-picker-cancelled") {
        await resetState();
        return { ok: true };
    }
    if (message.type === "desktop-picker-error") {
        await setState({ state: STATE.error, error: message.error ?? t("couldNotCapture") });
        return { ok: true };
    }
    return startCapturedRecording({
        tabId: state.tabId,
        platformHint: state.platformHint,
        auto: state.autoStarted,
        noticeAcknowledgedAt: state.noticeAcknowledgedAt,
        captureMode: "desktop",
        captureWindowId: state.captureWindowId,
        pickerRequestId: state.pickerRequestId,
    }).then(() => ({ ok: true }));
}

// ---- Internal messaging (popup, options, offscreen, content script) --------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target === "offscreen") return false;

    switch (message.type) {
        case "desktop-capture-ready":
        case "desktop-picker-cancelled":
        case "desktop-picker-error":
            handleDesktopPickerMessage(message, sender)
                .then(sendResponse)
                .catch((error) =>
                    sendResponse({ ok: false, error: error?.message ?? String(error) }),
                );
            return true;

        case "get-state":
            reconcileDesktopWindow()
                .then(getState)
                .then((state) => sendResponse({ state }));
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
            retryUpload()
                .then(() => sendResponse({ ok: true }))
                .catch((error) =>
                    sendResponse({ ok: false, error: error?.message ?? String(error) }),
                );
            return true;

        case "save-prefix":
            savePlayablePrefix(message.chunkCount)
                .then(() => sendResponse({ ok: true }))
                .catch((error) => sendResponse({ ok: false, error: error?.message ?? String(error) }));
            return true;

        case "discard-session":
            discardSession(message.sessionId)
                .then(() => sendResponse({ ok: true }))
                .catch((error) =>
                    sendResponse({ ok: false, error: error?.message ?? String(error) }),
                );
            return true;

        case "discard-buffer":
            discardBuffer(message.bufferId)
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
            getSettings()
                .then((settings) => {
                    if (!settings.dataUseAcknowledgedAt) {
                        return { ok: false, error: t("dataUseRequired") };
                    }
                    return queuePairing(message, originOf(sender.url ?? ""));
                })
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
                t("micUnavailable"),
                t("micUnavailableBody"),
            );
            return false;

        case "stream-ended":
            stopRecording("stream-ended");
            return false;

        case "capture-error":
            void stopRecording("error").then(() =>
                setState({ state: STATE.error, blocked: true, error: message.message }),
            );
            return false;

        default:
            return false;
    }
});

async function handleRecordingStopped(message) {
    const state = await getState();
    if (state.sessionId !== message.sessionId) return;
    if (state.captureMode === "desktop") {
        await setState({ stopped: true });
        if (state.captureWindowId != null) {
            await chrome.windows.remove(state.captureWindowId).catch(() => {});
        }
    } else {
        await closeOffscreen();
    }

    if (!message.chunkCount || message.chunkCount < 1) {
        await discardSession(message.sessionId);
        await notify(
            t("nothingRecorded"),
            t("nothingRecordedBody"),
        );
        return;
    }

    const stored = await listChunkIndices(state.bufferId ?? message.sessionId);
    const available = new Set([...stored, ...state.uploaded]);
    const firstMissing = Array.from(
        { length: message.chunkCount },
        (_, index) => index,
    ).find((index) => !available.has(index));
    await setState({
        stopped: true,
        chunkCount: message.chunkCount,
        recoverablePrefix: firstMissing && firstMissing > 0 ? firstMissing : null,
    });
    await pumpUploads();
}

async function savePlayablePrefix(chunkCount) {
    const state = await getState();
    if (
        !state.stopped ||
        !state.sessionId ||
        !Number.isInteger(chunkCount) ||
        chunkCount < 1 ||
        chunkCount >= state.chunkCount ||
        chunkCount !== state.recoverablePrefix
    ) {
        throw new Error("No verified playable prefix is available");
    }
    await setState({ blocked: false });
    await finalize(chunkCount);
}

async function retryUpload() {
    const state = await getState();
    if (!state.sessionId) return;
    const settings = await getSettings();
    const auth = { serverUrl: settings.serverUrl, apiKey: await readToken() };
    let remote = await getSession(auth, state.sessionId);
    if (remote.status === "completed" || remote.status === "completing") {
        await reconcileServerSession(state.sessionId, auth);
        return;
    }
    if (remote.status === "aborted" || remote.status === "failed") {
        remote = await recoverSession(auth, state.sessionId);
        const bufferId = state.bufferId ?? state.sessionId;
        const meta = await readLocalMeta(bufferId);
        if (meta) {
            await createLocalSession(bufferId, {
                ...meta,
                serverSessionId: remote.id,
            });
        }
    }
    if (remote.status !== "open") throw new Error("Recording cannot be retried");
    await setState({
        sessionId: remote.id,
        uploaded: remote.received_chunks ?? [],
        blocked: false,
        recoverablePrefix: null,
        state: STATE.error,
    });
    const bufferId = state.bufferId ?? state.sessionId;
    const meta = await readLocalMeta(bufferId);
    if (meta) {
        await createLocalSession(bufferId, {
            ...meta,
            retryAttempt: 0,
            nextRetryAt: null,
        });
    }
    await pumpUploads();
}

async function discardSession(sessionId) {
    const settings = await getSettings();
    const state = await getState();
    if (sessionId && settings.serverUrl && settings.hasApiKey) {
        await abortSession(
            { serverUrl: settings.serverUrl, apiKey: await readToken() },
            sessionId,
        ).catch(() => {});
    }
    if (sessionId) await deleteLocalSession(state.bufferId ?? sessionId);
    await resetState();
}

async function discardBuffer(bufferId) {
    const state = await getState();
    if (state.bufferId === bufferId && state.state === STATE.recording) {
        throw new Error("Stop recording before discarding its buffer");
    }
    const meta = await readLocalMeta(bufferId);
    if (!meta) return;
    const settings = await getSettings();
    if (meta.serverUrl === settings.serverUrl && settings.hasApiKey) {
        const auth = { serverUrl: settings.serverUrl, apiKey: await readToken() };
        try {
            const remote = await getSession(auth, meta.serverSessionId ?? bufferId);
            if (remote.status === "completing") {
                throw new Error("Wait for server finalization before discarding");
            }
            if (remote.status === "open" || remote.status === "failed") {
                await abortSession(auth, meta.serverSessionId ?? bufferId);
            }
        } catch (error) {
            if (error?.status !== 401 && error?.status !== 403 && error?.status !== 404) {
                throw error;
            }
        }
    }
    await deleteLocalSession(bufferId);
    if (state.bufferId === bufferId) await resetState();
}

// ---- Startup ---------------------------------------------------------------

async function reconcileOnStartup() {
    await ensureConfigAlarm();
    await reconcileDesktopWindow();
    // Session storage is empty after a browser restart; re-arm open meetings.
    await reevaluateAllTabs();

    const settings = await getSettings();
    if (!settings.dataUseAcknowledgedAt || !settings.serverUrl || !settings.hasApiKey) return;
    let token;
    try {
        token = await readToken();
    } catch (error) {
        const [bufferId] = await listLocalSessions();
        if (bufferId) {
            await setState({
                state: STATE.error,
                sessionId: bufferId,
                bufferId,
                stopped: true,
                blocked: true,
                error: error?.message ?? t("keyRejected"),
            });
        }
        return;
    }
    const auth = { serverUrl: settings.serverUrl, apiKey: token };

    const state = await getState();
    if (state.state === STATE.recording && state.captureMode === "desktop") {
        pumpUploads();
        return;
    }
    if (state.state === STATE.recording && (await hasOffscreen())) {
        pumpUploads();
        return;
    }
    if (state.state === STATE.finalizing && state.sessionId) {
        await reconcileServerSession(state.sessionId, auth).catch(() =>
            chrome.alarms.create(ALARMS.uploadRetry, { delayInMinutes: 1 }),
        );
        return;
    }

    for (const sessionId of await listLocalSessions()) {
        const meta = await readLocalMeta(sessionId);
        if (!meta || meta.serverUrl !== settings.serverUrl) continue;
        let serverSessionId = meta.serverSessionId ?? sessionId;
        let session;
        try {
            session = await getSession(auth, serverSessionId);
        } catch (error) {
            await setState({
                state: STATE.error,
                sessionId: serverSessionId,
                bufferId: sessionId,
                stopped: true,
                blocked: true,
                error: error?.message ?? t("recoveryUnavailable"),
            });
            continue;
        }
        if (session.status === "completed") {
            await setState({ sessionId: serverSessionId, bufferId: sessionId });
            await reconcileServerSession(serverSessionId, auth);
            continue;
        }
        if (session.status === "completing") {
            await setState({ state: STATE.finalizing, sessionId: serverSessionId, bufferId: sessionId, jobId: session.job_id });
            await chrome.alarms.create(ALARMS.uploadRetry, { delayInMinutes: 1 });
            break;
        }
        if (session.status === "aborted" || session.status === "failed") {
            try {
                session = await recoverSession(auth, serverSessionId);
                serverSessionId = session.id;
                await createLocalSession(sessionId, {
                    ...meta,
                    serverSessionId,
                });
            } catch (error) {
                await setState({
                    state: STATE.error,
                    sessionId: serverSessionId,
                    bufferId: sessionId,
                    stopped: true,
                    blocked: true,
                    error: error?.message ?? t("recoveryUnavailable"),
                });
                continue;
            }
        }
        if (session.status !== "open") continue;
        const stored = await listChunkIndices(sessionId);
        if (stored.length === 0) continue;
        // Only resume into a recording state when nothing else is active.
        const live = await getState();
        if (live.state !== STATE.idle && live.state !== STATE.error) break;
        await chrome.storage.session.set({
            [STATE_KEY]: {
                ...live,
                state: STATE.recording,
                sessionId: serverSessionId,
                bufferId: sessionId,
                startedAt: meta.startedAt ?? null,
                platformHint: meta.platformHint ?? null,
                chunkCount: Math.max(...stored) + 1,
                stopped: true,
                stopReason: "browser-closed",
                uploaded: session.received_chunks ?? [],
                blocked: false,
            },
        });
        if (meta.nextRetryAt && Date.parse(meta.nextRetryAt) > Date.now()) {
            await chrome.alarms.create(ALARMS.uploadRetry, {
                when: Date.parse(meta.nextRetryAt),
            });
            break;
        }
        await pumpUploads();
        break;
    }

    const buffered = await totalBufferedBytes();
    if (buffered > OPFS_WARN_BYTES) {
        await notify(
            t("unsentRecordings"),
            t("unsentRecordingsBody"),
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
