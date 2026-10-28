// Chatterbox Meeting Recorder service worker.
//
// Owns the recording lifecycle: starts capture (current tab from the popup
// or a source chosen in Chrome’s picker), creates the server session, drives
// the offscreen document, pumps buffered chunks to the server, and completes
// the session. Also owns auto mode: detecting meeting tabs,
// arming the toolbar icon for one-click start, nudging, and auto-stop.
//
// Capture lives in the offscreen document for tabs and in a persistent
// extension window for desktop audio. Chunks travel through shared OPFS.
// Every piece of per-tab state lives in chrome.storage.session, never in
// module scope: MV3 suspends this worker between events.

import {
    AGENDA_ALARM_PREFIX,
    AGENDA_SELECTION_KEY,
    agendaCompletion,
    agendaFolder,
    agendaPanelKey,
    agendaRequest,
    canChooseRecordingAgenda,
    clearAgendaReminders,
    clearAgendas,
    currentAgendas,
    matchAgendas,
    openAgendaPanel,
    refreshAgendas,
    remindAgenda,
    supportsAgendas,
} from "./lib/agendas.js";

import {
    abortSession,
    completeSession,
    createSession,
    getSession,
    getRecorderFolder,
    recoverSession,
    searchRecorderFolders,
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
import { microphoneError, microphonePermission } from "./lib/microphone.js";
import { meetingTarget, sameMeetingTarget } from "./lib/meeting-target.js";
import {
    hasMeetingPromptAccess,
    injectMeetingPrompt,
    isPromptMeeting,
    reconcileMeetingPrompt,
    meetingPromptPermissionChanged,
} from "./lib/meeting-prompt.js";
import {
    connectGrantedOrigins,
    getInstallationId,
    hasPairingRelayAccess,
    originOf,
    refreshServerConfig,
    unregisterPairingScripts,
} from "./lib/pairing.js";
import { queuePairing } from "./lib/pairing-request.js";
import { pickerWindowBounds } from "./lib/picker-window.js";
import { activeSetupFlow, resumeTypedSetupAfterLogin } from "./lib/setup-flow.js";
import { detectMeetingPlatform, platformById } from "./lib/platforms.js";
import { canPumpUploads } from "./lib/upload-state.js";
import { readToken } from "./lib/token-vault.js";
import {
    anyPlatformAuto,
    effectiveNoticeText,
    effectivePlatformModes,
    effectiveQuietSeconds,
    getSettings,
    isPaired,
    saveSettings,
} from "./lib/settings.js";
import {
    openStartRequest,
    START_REQUEST_KEY,
    START_REQUEST_TTL_MS,
} from "./lib/start-request.js";

const STATE_KEY = "recordingState";
const ARMED_KEY = "armedTabs";
const OFFSCREEN_URL = "offscreen/offscreen.html";
const POPUP_URL = "popup/popup.html";
const DEFAULT_TITLE = t("extensionName");
const OPFS_WARN_BYTES = 1024 * 1024 * 1024; // 1 GiB of unsent audio.
const NUDGE_PREFIX = "nudge:";
const COMPLETION_PREFIX = "completed:";
const COMPLETION_DISPLAY_MS = 3500;

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
    agendaId: null,
    agendaTitle: null,
    agendaExplicit: false,
    agendaUnavailable: false,
    folderId: null,
    folderLabel: null,
    recordingFolderOverride: false,
    tabId: null,
    autoStarted: false,
    chunkCount: 0,
    stopped: false,
    stopReason: "user",
    uploaded: [],
    blocked: false,
    recoverablePrefix: null,
    jobId: null,
    finalizingAt: null,
    recordingUrl: null,
    partial: false,
    error: null,
    micWarning: null,
    withoutMicrophone: false,
    levels: { micDb: -100, systemDb: -100 },
});

/** @returns {Promise<RecordingState>} */
async function getState() {
    const raw = await chrome.storage.session.get(STATE_KEY);
    return raw[STATE_KEY] ?? { ...IDLE_STATE };
}

let stateUpdates = Promise.resolve();

function setState(patch) {
    const update = stateUpdates.catch(() => {}).then(() => writeState(patch));
    stateUpdates = update;
    return update;
}

async function writeState(patch) {
    const current = await getState();
    const next = { ...current, ...patch };
    await chrome.storage.session.set({ [STATE_KEY]: next });
    chrome.runtime.sendMessage({ type: "state", state: next }).catch(() => {});
    await updateRecordingBadge(next);
    const bannerFields = [
        "state", "tabId", "startedAt", "stopped", "folderId", "folderLabel",
        "recordingFolderOverride", "error", "agendaId",
    ];
    if (Object.keys(patch).some((key) => bannerFields.includes(key))) {
        // State writes must bypass bannerUpdates so capture never waits for a queued agenda lookup.
        if (current.tabId != null && current.tabId !== next.tabId) await syncMeetingBannerNow(current.tabId, true);
        if (next.tabId != null) await syncMeetingBannerNow(next.tabId, true);
    }
    return next;
}

async function resetState() {
    await stateUpdates;
    const previous = await getState();
    await chrome.storage.session.remove(STATE_KEY);
    const next = await getState();
    chrome.runtime.sendMessage({ type: "state", state: next }).catch(() => {});
    await updateRecordingBadge(next);
    // Clear the recording badge on the tab that was recording, then let the
    // evaluation put the armed badge back if the tab is still in a meeting.
    if (previous.tabId != null) {
        await syncMeetingBanner(previous.tabId);
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
        withoutMicrophone: input.withoutMicrophone ?? false,
        error: null,
    });
    try {
        const url = new URL(chrome.runtime.getURL("picker/picker.html"));
        url.searchParams.set("requestId", requestId);
        const anchor = await chrome.windows
            .getLastFocused({ windowTypes: ["normal"] })
            .catch(() => null);
        const pickerWindow = await chrome.windows.create({
            url: url.href,
            type: "popup",
            focused: true,
            ...pickerWindowBounds(anchor),
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
    void chrome.storage.session.get(START_REQUEST_KEY).then(async (stored) => {
        if (stored[START_REQUEST_KEY]?.windowId === windowId)
            await chrome.storage.session.remove(START_REQUEST_KEY);
    }).catch((error) => console.warn("[recorder] request window cleanup:", error));
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
async function startRecording(input, microphoneChecked = false) {
    if (starting) throw new Error(t("alreadyInProgress"));
    starting = true;
    try {
        return await startRecordingLocked(input, microphoneChecked);
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
    withoutMicrophone = false,
    forceDesktop = false,
    fromPopup = false,
    agendaId,
    bannerAgendaId,
    folderId,
    folderLabel,
}, microphoneChecked) {
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
    if (tabId != null) {
        await updateArmedTab(tabId, (entry) => entry ? {
            ...entry, bannerError: null, errorDismissed: false,
        } : entry);
    }
    await prepareRecordingAgenda(tabId, fromPopup ? agendaId : bannerAgendaId);
    const apiKey = await readToken();
    if (!microphoneChecked && (await microphonePermission()) !== "granted") {
        return openStartRequest({
            tabId,
            platformHint,
            auto,
            noticeAcknowledgedAt,
        });
    }
    if (!noticeAcknowledgedAt) throw new Error(t("participantAckRequired"));

    await setState({
        state: STATE.awaitingPicker,
        meetingTarget: tabId != null
            ? meetingTarget((await chrome.tabs.get(tabId).catch(() => null))?.url)
            : null,
        tabId: tabId ?? null,
        platformHint: platformHint ?? null,
        error: null,
        micWarning: null,
        meetingBannerErrorDismissed: false,
        popupFolder: fromPopup && folderId !== undefined ? { folderId, folderLabel: folderLabel ?? null } : null,
        withoutMicrophone,
    });

    const useTab =
        !forceDesktop && typeof tabId === "number" && (fromPopup || Boolean(platformHint));
    if (!useTab) {
        return openDesktopRecorder({ tabId, platformHint, auto, noticeAcknowledgedAt, withoutMicrophone });
    }

    return startCapturedRecording({
        tabId,
        platformHint,
        auto,
        noticeAcknowledgedAt,
        captureMode: "tab",
        withoutMicrophone,
        apiKey,
    });
}

async function startCapturedRecording({
    tabId,
    platformHint,
    auto = false,
    noticeAcknowledgedAt,
    captureMode,
    withoutMicrophone = false,
    captureWindowId = null,
    pickerRequestId = null,
    apiKey,
}) {
    const settings = await getSettings();
    const selection = (await chrome.storage.session.get(AGENDA_SELECTION_KEY))[AGENDA_SELECTION_KEY];
    const selectedAgenda = supportsAgendas(settings) && selection?.serverUrl === settings.serverUrl && selection.connectionId === settings.connectionId ? selection.agenda : null;
    const agendaExplicit = supportsAgendas(settings) && selection?.serverUrl === settings.serverUrl && selection.connectionId === settings.connectionId && selection.explicit === true;
    const popupFolder = (await getState()).popupFolder;
    const selectedFolder = popupFolder ?? (selectedAgenda ? agendaFolder(selectedAgenda) : {});
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

    const sessionBody = {
        clientRecordingId,
        mimeType: SESSION_MIME_TYPE,
        channelLayout,
        startedAt,
        platformHint: platformHint ?? undefined,
        clientVersion: chrome.runtime.getManifest().version,
        timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
        noticeAcknowledgedAt: noticeAcknowledgedAt ?? startedAt,
        folderId: "folderId" in selectedFolder ? selectedFolder.folderId ?? undefined : settings.folderId ?? undefined,
    };
    let session;
    let folderId = "folderId" in selectedFolder ? selectedFolder.folderId : settings.folderId ?? null;
    let folderLabel = selectedFolder.folderLabel ?? settings.folderLabel ?? null;
    try {
        try {
            session = await createSession(auth, sessionBody);
        } catch (error) {
            if (
                folderId &&
                error?.status === 400 &&
                error?.field === "folderId"
            ) {
                folderId = null;
                folderLabel = null;
                if (!selectedFolder.folderId) await saveSettings({ folderId, folderLabel });
                const fallbackBody = { ...sessionBody };
                delete fallbackBody.folderId;
                session = await createSession(auth, fallbackBody);
            } else {
                throw error;
            }
        }
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

        const folder = {
            agendaId: selectedAgenda?.id ?? null,
            agendaTitle: selectedAgenda?.title ?? null,
            agendaExplicit,
            agendaUnavailable: false,
            folderId,
            folderLabel,
            startFolderId: folderId,
            startFolderLabel: folderLabel,
            recordingFolderOverride: settings.serverDefaults?.recordingFolderOverride === true,
        };
        const { agendaTitle: _title, ...persistentFolder } = folder;
        await createLocalSession(session.id, {
            ...persistentFolder,
            serverSessionId: session.id,
            clientRecordingId,
            serverUrl: settings.serverUrl,
            keyExpiresAt: session.encryption.expires_at,
            startedAt,
            platformHint: platformHint ?? null,
            done: false,
        });

        await setState({
            ...folder,
            meetingTarget: tabId != null
                ? meetingTarget((await chrome.tabs.get(tabId).catch(() => null))?.url)
                : null,
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
            finalizingAt: null,
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
                return openDesktopRecorder({ tabId, platformHint, auto, noticeAcknowledgedAt, withoutMicrophone });
            }
            response = await messageOffscreen("start", {
                sessionId: session.id,
                clientRecordingId,
                captureKey: session.encryption.key,
                captureMode,
                channelMode: settings.channelMode,
                streamId,
                microphoneId: settings.microphoneId,
                withoutMicrophone,
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
                withoutMicrophone,
            });
        }
        if (!response?.ok) {
            throw new Error(response?.error || t("couldNotCapture"));
        }

        await chrome.storage.session.remove(AGENDA_SELECTION_KEY);
        if (tabId != null) void syncMeetingBanner(tabId).catch(() => {});
        return { sessionId: session.id };
    } catch (error) {
        if (captureMode === "tab") await closeOffscreen().catch(() => {});
        const state = await getState();
        const ownsState = state.sessionId === session.id;
        if (state.sessionId === session.id && (await listChunkIndices(session.id)).length === 0) {
            await discardSession(session.id);
        } else if (state.sessionId === session.id) {
            await setState({
                state: STATE.error,
                sessionId: session.id,
                bufferId: session.id,
                stopped: true,
                blocked: true,
                captureWindowId: null,
                error: error?.message ?? String(error),
            });
        }
        const latest = await getState();
        if (
            captureMode === "tab" ||
            (ownsState && latest.state === STATE.idle) ||
            latest.sessionId === session.id ||
            (latest.state === STATE.awaitingPicker &&
                latest.pickerRequestId === pickerRequestId)
        ) {
            await setState({
                state: STATE.error,
                captureWindowId: null,
                error: error?.message ?? String(error),
            });
        }
        if (captureMode === "desktop") {
            await chrome.windows.remove(captureWindowId).catch(() => {});
        }
        throw error;
    }
}

async function stopRecording(reason = "user", expected = null) {
    await folderUpdates;
    const state = await getState();
    if (expected && (state.tabId !== expected.tabId || state.sessionId !== expected.sessionId)) throw new Error(t("unrecognizedSender"));
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

let metaUpdates = Promise.resolve();
let folderUpdates = Promise.resolve();

function updateLocalMeta(bufferId, patch) {
    const update = metaUpdates.catch(() => {}).then(async () => {
        const meta = await readLocalMeta(bufferId);
        if (!meta) throw new Error(t("recoveryUnavailable"));
        const { agendaTitle: _title, ...persistentPatch } = patch;
        const { agendaTitle: _previousTitle, ...persistentMeta } = meta;
        await createLocalSession(bufferId, { ...persistentMeta, ...persistentPatch });
    });
    metaUpdates = update;
    return update;
}

async function applyRecordingFolder(state, folder, remember = true) {
    await updateLocalMeta(state.bufferId ?? state.sessionId, folder);
    await setState(folder);
    if (remember) await saveSettings(folder);
}

function updateRecordingFolder(message, sender) {
    const update = folderUpdates.catch(() => {}).then(async () => {
        const state = await getState();
        const popup = sender.url === chrome.runtime.getURL(POPUP_URL);
        const pickerUrl = chrome.runtime.getURL("picker/picker.html");
        const picker = Boolean(sender.url?.startsWith(`${pickerUrl}?`)) &&
            state.pickerRequestId != null &&
            new URL(sender.url).searchParams.get("requestId") === state.pickerRequestId &&
            sender.tab?.windowId === state.captureWindowId;
        if (!popup && !picker && !(await validMeetingBannerSender(sender, state))) throw new Error(t("unrecognizedSender"));
        const settings = await getSettings();
        if (state.sessionId !== message.sessionId || state.state !== STATE.recording ||
            state.stopped || !state.recordingFolderOverride ||
            settings.serverDefaults?.recordingFolderOverride !== true) {
            throw new Error(t("folderChangeFailed"));
        }
        if (message.folderId !== null && (typeof message.folderId !== "string" ||
            !message.folderId.trim() || message.folderId.length > 255)) {
            throw new Error(t("folderChangeFailed"));
        }
        const folder = {
            folderId: message.folderId,
            folderLabel: message.folderId && typeof message.folderLabel === "string"
                ? message.folderLabel : null,
        };
        await applyRecordingFolder(state, folder, message.remember !== false);
        return { ok: true };
    });
    folderUpdates = update.catch(() => {});
    return update;
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
                        uploadNotice: null,
                    });
                    if (meta?.nextRetryAt) {
                        await updateLocalMeta(bufferId, {
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
                            error: accessErrorMessage(error) ?? error?.message ?? t("keyRejected"),
                        });
                    } else {
                        if (error?.code === "ACCESS_UNVERIFIABLE") {
                            await setState({ uploadNotice: t("accessUnverifiable") });
                        }
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

/**
 * What to tell the person when the server refused the recorder's key for
 * access reasons. The encrypted recording stays in this browser either way.
 */
function accessErrorMessage(error) {
    if (error?.code === "ACCESS_NOT_GRANTED") return t("accessWithdrawn");
    if (error?.status === 401) return t("keyRejected");
    return null;
}

async function finalize(truncatedAtChunk = null) {
    await folderUpdates;
    const state = await getState();
    if (!state.sessionId || !state.stopped) return;
    if (state.state === STATE.finalizing && state.jobId) return;

    await setState({
        state: STATE.finalizing,
        finalizingAt: new Date().toISOString(),
    });
    try {
        const settings = await getSettings();
        const auth = { serverUrl: settings.serverUrl, apiKey: await readToken() };
        const body = {
            chunkCount: state.chunkCount,
            ...(truncatedAtChunk ? { truncatedAtChunk } : {}),
            endedAt: new Date().toISOString(),
            stopReason: state.stopReason,
            ...agendaCompletion(settings, state),
            ...(settings.serverDefaults?.recordingFolderOverride === true &&
                state.recordingFolderOverride === true
                ? { folderId: state.folderId ?? null }
                : {}),
        };
        let result;
        try {
            result = await completeSession(auth, state.sessionId, body);
        } catch (error) {
            if ("folderId" in body && error?.status === 400 && error?.field === "folderId") {
                const fallbackBody = { ...body };
                delete fallbackBody.folderId;
                result = await completeSession(auth, state.sessionId, fallbackBody);
                await applyRecordingFolder(state, {
                    folderId: state.startFolderId ?? null,
                    folderLabel: state.startFolderLabel ?? null,
                }, !state.agendaExplicit || !state.agendaId);
            } else {
                throw error;
            }
        }
        const agendaUnavailable = result.agenda?.attached === false && result.agenda.reason === "unavailable";
        if (agendaUnavailable) await updateLocalMeta(state.bufferId ?? state.sessionId, { agendaUnavailable });
        await setState({ jobId: result.job_id ?? null, agendaUnavailable });

        await reconcileServerSession(state.sessionId, auth);
    } catch (error) {
        await setState({
            state: STATE.error,
            error:
                accessErrorMessage(error) ??
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
    await updateLocalMeta(sessionId, { retryAttempt: attempt, nextRetryAt });
    await chrome.alarms.create(ALARMS.uploadRetry, {
        when: Date.parse(nextRetryAt),
    });
}

const pendingReconciliations = new Map();

async function reconcileServerSession(sessionId, auth) {
    const pending = pendingReconciliations.get(sessionId);
    if (pending) return pending;
    const work = reconcileServerSessionOnce(sessionId, auth);
    pendingReconciliations.set(sessionId, work);
    try {
        return await work;
    } finally {
        if (pendingReconciliations.get(sessionId) === work) {
            pendingReconciliations.delete(sessionId);
        }
    }
}

async function reconcileServerSessionOnce(sessionId, auth) {
    const remote = await getSession(auth, sessionId);
    if (remote.status === "completing") {
        await chrome.alarms.create(ALARMS.uploadRetry, { delayInMinutes: 0.5 });
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
        const url = new URL("/dashboard", auth.serverUrl);
        url.searchParams.set("recording", remote.recording_id);
        const recordingUrl = url.href;
        await deleteLocalSession(state.bufferId ?? sessionId);
        await setState({
            state: STATE.completed,
            recordingUrl,
            partial: Boolean(remote.truncated_at_chunk),
        });
        const completionBody = remote.truncated_at_chunk ? t("partialRecordingSent") : t("recordingSentBody");
        await notify(
            t("recordingSent"),
            completionBody + (state.agendaUnavailable ? `\n${t("agendaUnavailable")}` : ""),
            { id: `${COMPLETION_PREFIX}${encodeURIComponent(recordingUrl)}` },
        );
        await new Promise((resolve) => setTimeout(resolve, COMPLETION_DISPLAY_MS));
        const shown = await getState();
        if (shown.state !== STATE.completed || shown.sessionId !== sessionId) return;
        await resetState();
        await new Promise((resolve) => setTimeout(resolve, 400));
        if ((await getState()).state === STATE.idle) {
            await navigateToRecording(auth.serverUrl, recordingUrl, state.tabId).catch(() => {});
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

async function cachedBannerAgendas(tab, settings) {
    const cached = (await chrome.storage.session.get(`agenda-match:${tab.id}`))[`agenda-match:${tab.id}`];
    return cached?.target === JSON.stringify(meetingTarget(tab.url)) && cached.serverUrl === settings.serverUrl && cached.connectionId === settings.connectionId && Date.now() - cached.at < 60000 ? currentAgendas(cached.agendas) : [];
}

async function bannerAgendas(tab, { strict = false } = {}) {
    const key = `agenda-match:${tab.id}`;
    const target = JSON.stringify(meetingTarget(tab.url));
    const cached = (await chrome.storage.session.get(key))[key];
    const settings = await getSettings();
    if (cached?.target === target && cached.serverUrl === settings.serverUrl && cached.connectionId === settings.connectionId && Date.now() - cached.at < 60000) return currentAgendas(cached.agendas);
    const controller = new AbortController();
    let timer;
    try {
        const agendas = await Promise.race([
            matchAgendas(tab.url, Date.now(), { signal: controller.signal }),
            new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Agenda match timed out")); }, 1000); }),
        ]);
        if (controller.signal.aborted) return [];
        await chrome.storage.session.set({ [key]: { target, serverUrl: settings.serverUrl, connectionId: settings.connectionId, at: Date.now(), agendas } });
        return agendas;
    } catch (error) { if (strict) throw error; return []; }
    finally { clearTimeout(timer); }
}

async function prepareRecordingAgenda(tabId, shownAgendaId) {
    const settings = await getSettings();
    if (!supportsAgendas(settings)) return;
    const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
    const target = JSON.stringify(meetingTarget(tab?.url));
    const selected = (await chrome.storage.session.get(AGENDA_SELECTION_KEY))[AGENDA_SELECTION_KEY];
    if (selected?.explicit === true && selected.serverUrl === settings.serverUrl && selected.connectionId === settings.connectionId &&
        (selected.target === target || (selected.explicit && selected.target === "null")) &&
        Date.now() - selected.at < 15 * 60000) return;
    const entry = tab ? (await getArmed())[tab.id] : null;
    const shown = shownAgendaId !== undefined ? shownAgendaId :
        settings.agendaBanner && entry?.promptVisible ? entry.shownAgendaId : undefined;
    const cached = tab ? (await chrome.storage.session.get(`agenda-match:${tab.id}`))[`agenda-match:${tab.id}`] : null;
    const matches = cached?.target === target && cached.serverUrl === settings.serverUrl && cached.connectionId === settings.connectionId
        ? currentAgendas(cached.agendas) : [];
    const agenda = shown ? matches.find((row) => row.id === shown) : null;
    if (!agenda && shownAgendaId !== null) {
        await chrome.storage.session.remove(AGENDA_SELECTION_KEY);
        return;
    }
    await chrome.storage.session.set({ [AGENDA_SELECTION_KEY]: {
        serverUrl: settings.serverUrl, connectionId: settings.connectionId, target, at: Date.now(), agenda: agenda ?? null, explicit: true,
    } });
}

function handleAgendaMessage(message, sender) {
    if (message.type !== "select-agenda") return handleAgendaMessageNow(message, sender);
    const update = folderUpdates.catch(() => {}).then(() => handleAgendaMessageNow(message, sender));
    folderUpdates = update.catch(() => {});
    return update;
}

async function handleAgendaMessageNow(message, sender) {
    if (sender.id !== chrome.runtime.id ||
        ![POPUP_URL, "agenda/agenda.html"].some((path) => sender.url?.split("?")[0] === chrome.runtime.getURL(path))) throw new Error(t("unrecognizedSender"));
    const settings = await getSettings();
    if (!supportsAgendas(settings)) return { ok: true, agendas: [] };
    const tab = message.tabId != null ? await chrome.tabs.get(message.tabId).catch(() => null) : null;
    if (message.type === "match-agendas") {
        void refreshAgendas({ force: true }).catch(() => {});
        const agendas = tab ? await bannerAgendas(tab, { strict: true }) : await matchAgendas();
        const selected = (await chrome.storage.session.get(AGENDA_SELECTION_KEY))[AGENDA_SELECTION_KEY];
        const target = JSON.stringify(meetingTarget(tab?.url));
        const hasSelection = selected?.serverUrl === settings.serverUrl && selected.connectionId === settings.connectionId && selected.explicit &&
            (selected.target === target || selected.target === "null") && Date.now() - selected.at < 15 * 60000;
        return { ok: true, agendas, ...(hasSelection ? { selectedAgenda: selected.agenda } : {}) };
    }
    let agenda = null;
    if (message.agendaId != null) {
        agenda = await agendaRequest(`/${encodeURIComponent(message.agendaId)}`);
        if (!agenda.permissions?.edit) throw new Error(t("agendaFailed"));
        agenda = { ...agenda, start: agenda.plannedStart, end: agenda.plannedEnd };
    }
    const state = await getState();
    if (message.sessionId) {
        if (state.sessionId !== message.sessionId || !canChooseRecordingAgenda(state)) throw new Error(t("agendaFailed"));
        const patch = { agendaId: agenda?.id ?? null, agendaTitle: agenda?.title ?? null, agendaExplicit: true,
            folderId: settings.folderId, folderLabel: settings.folderLabel,
            ...agendaFolder(agenda) };
        await updateLocalMeta(state.bufferId ?? state.sessionId, patch);
        await setState(patch);
    } else {
        const target = JSON.stringify(meetingTarget(tab?.url));
        await chrome.storage.session.set({ [AGENDA_SELECTION_KEY]: { serverUrl: settings.serverUrl, connectionId: settings.connectionId, target, at: Date.now(), agenda, explicit: true } });
    }
    return { ok: true, agenda };
}

async function resolvePanelAgenda(message, sender, meeting, opened) {
    if (meeting && !(await validMeetingBannerSender(sender))) throw new Error(t("unrecognizedSender"));
    const settings = await getSettings();
    if (!supportsAgendas(settings) || (meeting && !settings.agendaBanner)) throw new Error(t("agendaUnsupported"));
    const state = await getState();
    const panelTabId = meeting ? sender.tab.id : message.tabId;
    const tabId = meeting ? panelTabId : message.matchTabId ?? panelTabId;
    const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
    const matches = await matchAgendas(tab?.url);
    const id = message.choose ? null : message.agendaId || (state.tabId === tabId ? state.agendaId : null) || (matches.length === 1 ? matches[0].id : null);
    const key = await opened;
    await chrome.storage.session.set({ [key]: { agendaIds: id ? [id] : matches.map((row) => row.id), choose: !id, tabId } });
    if (panelTabId != null && !(await chrome.tabs.get(panelTabId).catch(() => null))) await chrome.storage.session.remove(key);
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
            ...(options.contextMessage
                ? { contextMessage: options.contextMessage }
                : {}),
            ...(options.buttons ? { buttons: options.buttons } : {}),
        });
    } catch {
        return null;
    }
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
    if (notificationId.startsWith(AGENDA_ALARM_PREFIX)) {
        void openAgendaPanel({}, [notificationId.slice(AGENDA_ALARM_PREFIX.length)]).catch(() => {});
        void chrome.notifications.clear(notificationId);
        return;
    }
    if (notificationId.startsWith(COMPLETION_PREFIX)) {
        const url = decodeURIComponent(
            notificationId.slice(COMPLETION_PREFIX.length),
        );
        await chrome.tabs.create({ url });
        return;
    }
    if (!notificationId.startsWith(NUDGE_PREFIX)) return;
    await chrome.notifications.clear(notificationId);
    if (!(await hasMeetingPromptAccess())) {
        await chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html#meeting-prompt") });
    } else {
        const tabId = Number(notificationId.slice(NUDGE_PREFIX.length));
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) return;
        await chrome.tabs.update(tabId, { active: true }).catch(() => {});
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
});

chrome.notifications.onButtonClicked.addListener((id, button) => {
    if (id.startsWith(AGENDA_ALARM_PREFIX)) {
        if (button === 0) void openAgendaPanel({}, [id.slice(AGENDA_ALARM_PREFIX.length)]).catch(() => {});
        void chrome.notifications.clear(id);
        return;
    }
    void handleMeetingNotification(id, button).catch((error) =>
        notify(t("couldNotStart"), error.message),
    );
});

async function handleMeetingNotification(id, button) {
    if (!id.startsWith(NUDGE_PREFIX)) return;
    const tabId = Number(id.slice(NUDGE_PREFIX.length));
    const armed = await getArmed();
    const entry = armed[tabId];
    if (!entry) return;
    await chrome.notifications.clear(id);
    await dismissMeetingBanner(tabId);
    if (button !== 0) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const platform = tab?.url ? detectMeetingPlatform(tab.url) : null;
    if (!platform || platform.id !== entry.platformId) return;
    if (!(await isPaired())) return;
    // A notification is no invocation, so Chrome refuses tab capture here:
    // the meeting tab is shared through Chrome's dialog instead.
    await startRecording({
        tabId,
        platformHint: platform.id,
        auto: entry.mode === "auto",
        noticeAcknowledgedAt: new Date().toISOString(),
        forceDesktop: true,
    });
}

const MEETING_BANNER_MESSAGES = new Set(["meeting-banner-ready", "meeting-banner-dismiss", "meeting-banner-dialog"]);
let armedUpdates = Promise.resolve();
let bannerUpdates = Promise.resolve();

function updateArmedTab(tabId, update) {
    const work = armedUpdates.catch(() => {}).then(async () => {
        const armed = await getArmed();
        const next = update(armed[tabId]);
        if (next === armed[tabId] || (!next && !armed[tabId])) return next;
        if (next) armed[tabId] = next;
        else delete armed[tabId];
        await setArmed(armed);
        return next;
    });
    armedUpdates = work;
    return work;
}

async function sendMeetingBanner(tabId, payload) {
    try {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const topOffset = detectMeetingPlatform(tab?.url)?.promptTopOffset ?? 16;
        return await chrome.tabs.sendMessage(tabId, {
            type: "meeting-banner", ...payload,
            ...(payload.view !== "hidden" ? { topOffset } : {}),
        }, { frameId: 0 });
    } catch { return null; }
}

async function validMeetingBannerSender(sender, state = null) {
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
        !Number.isInteger(sender.tab?.id) || !isPromptMeeting(sender.url) ||
        !(await hasMeetingPromptAccess())) return false;
    const tab = await chrome.tabs.get(sender.tab.id).catch(() => null);
    if (!tab || !isPromptMeeting(tab.url) || !sameMeetingTarget(sender.url, tab.url)) return false;
    if (!(await isPaired()) || !(await getSettings()).dataUseAcknowledgedAt) return false;
    const current = state ?? await getState();
    const entry = (await getArmed())[tab.id];
    return Boolean((entry && sameMeetingTarget(entry.meetingTarget, tab.url)) ||
        (current.tabId === tab.id && current.meetingTarget && sameMeetingTarget(current.meetingTarget, tab.url)));
}

async function dismissMeetingBanner(tabId) {
    const entry = await updateArmedTab(tabId, (current) => current ? {
        ...current, nudged: true, dismissed: true, bannerPrompt: false, promptVisible: false, notificationFallback: false,
    } : null);
    await sendMeetingBanner(tabId, { view: "hidden" });
    await chrome.notifications.clear(`${NUDGE_PREFIX}${tabId}`).catch(() => {});
    await safe(chrome.action.setPopup({ tabId, popup: entry?.mode === "auto" ? "" : POPUP_URL }));
}

async function showMeetingBannerError(tabId, meetingUrl, error) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !isPromptMeeting(tab.url) || !sameMeetingTarget(meetingUrl, tab.url) ||
        !(await hasMeetingPromptAccess())) return;
    await dismissMeetingBanner(tabId);
    const bannerError = error?.message ?? String(error);
    const entry = await updateArmedTab(tabId, (entry) => entry ? {
        ...entry, bannerError,
    } : entry);
    if (entry?.errorDismissed) return;
    await sendMeetingBanner(tabId, { view: "error", state: { error: bannerError } });
}

function syncMeetingBanner(tabId, cachedOnly = false) {
    const work = bannerUpdates.catch(() => {}).then(() => syncMeetingBannerNow(tabId, cachedOnly));
    bannerUpdates = work;
    return work;
}

async function syncMeetingBannerNow(tabId, cachedOnly = false) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const settings = await getSettings();
    const enabled = tab && isPromptMeeting(tab.url) && settings.dataUseAcknowledgedAt &&
        await isPaired() && await hasMeetingPromptAccess();
    const agendas = enabled && supportsAgendas(settings) && settings.agendaBanner
        ? cachedOnly ? await cachedBannerAgendas(tab, settings) : await bannerAgendas(tab) : [];
    const state = await getState();
    const entry = (await getArmed())[tabId];
    const ownRecording = state.tabId === tabId &&
        (!state.meetingTarget || sameMeetingTarget(state.meetingTarget, tab?.url));
    if (enabled && ownRecording && state.state !== STATE.idle) {
        await updateArmedTab(tabId, (current) => current ? {
            ...current, bannerPrompt: false, promptVisible: false, nudged: true, dismissed: true,
        } : null);
        const recording = state.state === STATE.recording && !state.stopped;
        const view = state.state === STATE.error ? "error" : recording ? "recording" :
            state.state === STATE.awaitingPicker ? "waiting" : "stopped";
        if (view === "error" && (entry?.errorDismissed || state.meetingBannerErrorDismissed)) {
            await sendMeetingBanner(tabId, { view: "hidden" });
        } else await sendMeetingBanner(tabId, { view, state: {
            state: state.state,
            sessionId: state.sessionId,
            startedAt: state.startedAt,
            stopped: state.stopped,
            folderId: state.folderId,
            folderLabel: state.folderLabel,
            recordingFolderOverride: state.recordingFolderOverride === true && settings.serverDefaults?.recordingFolderOverride === true,
            error: state.error,
            agendas: supportsAgendas(settings) && settings.agendaBanner
                ? (state.agendaId ? [{ id: state.agendaId, title: state.agendaTitle }] : agendas) : [],
        } });
        await safe(chrome.action.setPopup({ tabId, popup: entry?.mode === "auto" ? "" : POPUP_URL }));
        return;
    }
    if (enabled && entry?.bannerError && !entry.errorDismissed &&
        sameMeetingTarget(entry.meetingTarget, tab.url)) {
        await sendMeetingBanner(tabId, { view: "error", state: { error: entry.bannerError } });
        await safe(chrome.action.setPopup({ tabId, popup: entry.mode === "auto" ? "" : POPUP_URL }));
        return;
    }
    if (enabled && settings.nudgeEnabled && entry?.bannerPrompt &&
        sameMeetingTarget(entry.meetingTarget, tab.url)) {
        const [commands, actionSettings] = await Promise.all([
            chrome.commands.getAll().catch(() => []),
            chrome.action.getUserSettings().catch(() => ({})),
        ]);
        const response = await sendMeetingBanner(tabId, {
            view: "prompt",
            agendas,
            notice: effectiveNoticeText(settings),
            shortcut: commands.find((command) => command.name === "toggle-recording")?.shortcut || "",
            pinned: actionSettings.isOnToolbar !== false,
            policyRequired: entry.mode === "auto" && !settings.autoModeAcknowledgedAt,
        });
        const next = await updateArmedTab(tabId, (current) => current ? {
            ...current,
            promptVisible: current.bannerPrompt === true && response?.visible === true,
            shownAgendaId: response?.visible === true && agendas.length === 1 ? agendas[0].id : undefined,
            notificationFallback: response?.visible === true ? false : current.notificationFallback,
        } : null);
        await applyArmedUi(tabId, platformById(entry.platformId), entry.mode, next?.promptVisible);
        if (next?.promptVisible) {
            await chrome.notifications.clear(`${NUDGE_PREFIX}${tabId}`).catch(() => {});
        } else if (next?.bannerPrompt && !next.notificationFallback) {
            await notifyMeetingNudge(tabId, platformById(entry.platformId), settings);
        }
        return;
    }
    await sendMeetingBanner(tabId, { view: "hidden" });
    if (entry?.promptVisible || entry?.bannerPrompt) {
        await updateArmedTab(tabId, (current) => current ? { ...current, promptVisible: false, bannerPrompt: false } : null);
        await safe(chrome.action.setPopup({ tabId, popup: entry.mode === "auto" ? "" : POPUP_URL }));
    }
}

async function handleMeetingBannerMessage(message, sender) {
    const state = await getState();
    if (!(await validMeetingBannerSender(sender, state))) throw new Error(t("unrecognizedSender"));
    const tabId = sender.tab.id;
    if (message.type === "meeting-banner-ready") {
        await syncMeetingBanner(tabId);
        return { ok: true };
    }
    if (message.type === "stop-recording") {
        if (state.tabId !== tabId || state.sessionId !== message.sessionId) throw new Error(t("unrecognizedSender"));
        await stopRecording("user", { tabId, sessionId: message.sessionId });
        return { ok: true };
    }
    if (message.type === "set-recording-folder") {
        if (state.tabId !== tabId) throw new Error(t("unrecognizedSender"));
        return updateRecordingFolder(message, sender);
    }
    if (message.type === "get-folders") {
        if (state.tabId !== tabId || state.state !== STATE.recording || state.stopped ||
            !state.recordingFolderOverride || (await getSettings()).serverDefaults?.recordingFolderOverride !== true) {
            throw new Error(t("folderChangeFailed"));
        }
        const settings = await getSettings();
        const auth = { serverUrl: settings.serverUrl, apiKey: await readToken() };
        try {
            const folders = typeof message.id === "string" ? await getRecorderFolder(auth, message.id) :
                typeof message.q === "string" ? await searchRecorderFolders(auth, message.q) : [];
            return { ok: true, folders };
        } catch (error) {
            return { ok: false, status: error?.status, error: error?.message ?? String(error) };
        }
    }
    const entry = (await getArmed())[tabId];
    if (message.type === "meeting-banner-dismiss" &&
        (entry?.bannerError || (state.tabId === tabId && state.state === STATE.error))) {
        if (entry) await updateArmedTab(tabId, (current) => current ? {
            ...current, errorDismissed: true,
        } : current);
        else await setState({ meetingBannerErrorDismissed: true });
        await dismissMeetingBanner(tabId);
        return { ok: true };
    }
    if (!entry?.promptVisible || !entry.bannerPrompt) throw new Error(t("unrecognizedSender"));
    await dismissMeetingBanner(tabId);
    if (message.type === "meeting-banner-dialog") {
        try {
            await startRecording({ tabId, platformHint: entry.platformId, auto: entry.mode === "auto",
                bannerAgendaId: entry.shownAgendaId ?? undefined,
                forceDesktop: true, noticeAcknowledgedAt: new Date().toISOString() });
        } catch (error) {
            await showMeetingBannerError(tabId, sender.url, error);
            throw error;
        }
    }
    return { ok: true };
}

async function reconcileMeetingPromptAndTabs() {
    const enabled = await reconcileMeetingPrompt();
    const armed = await getArmed();
    for (const id of Object.keys(armed)) {
        const tabId = Number(id);
        await updateArmedTab(tabId, (entry) => entry ? {
            ...entry, bannerPrompt: false, promptVisible: false, nudged: entry.dismissed === true,
        } : null);
        await sendMeetingBanner(tabId, { view: "hidden" });
        await safe(chrome.action.setPopup({ tabId, popup: armed[id].mode === "auto" ? "" : POPUP_URL }));
        if (enabled) await chrome.notifications.clear(`${NUDGE_PREFIX}${tabId}`).catch(() => {});
    }
    const state = await getState();
    if (state.tabId != null && !armed[state.tabId]) await syncMeetingBanner(state.tabId);
    if (enabled || Object.keys(armed).length) await reevaluateAllTabs();
}

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

async function applyArmedUi(tabId, platform, mode, promptVisible = false) {
    // In auto mode the popup is disabled on this tab, so the toolbar click is
    // a direct invocation that unlocks tab capture (verified in Phase 0).
    await safe(
        chrome.action.setPopup({
            tabId,
            popup: mode === "auto" || promptVisible ? "" : POPUP_URL,
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
    const entry = await updateArmedTab(tab.id, (existing) => {
        const same = existing?.platformId === platform.id &&
            (!existing.meetingTarget || sameMeetingTarget(existing.meetingTarget, tab.url));
        return {
            platformId: platform.id,
            meetingTarget: meetingTarget(tab.url),
            mode,
            nudged: same ? existing.nudged : false,
            dismissed: same && existing.dismissed === true,
            bannerPrompt: same && existing.bannerPrompt === true,
            promptVisible: same && existing.promptVisible === true,
            notificationFallback: same && existing.notificationFallback === true,
            errorDismissed: same && existing.errorDismissed === true,
            bannerError: same ? existing.bannerError ?? null : null,
            shownAgendaId: same ? existing.shownAgendaId : undefined,
        };
    });
    await applyArmedUi(tab.id, platform, mode, entry.promptVisible);
    const fresh = await chrome.tabs.get(tab.id).catch(() => null);
    if (fresh?.audible && !entry.nudged) await nudge(tab.id, platform);
    else await syncMeetingBanner(tab.id);
}

async function disarm(tabId) {
    if (!(await getArmed())[tabId]) return;
    await updateArmedTab(tabId, () => null);
    await sendMeetingBanner(tabId, { view: "hidden" });
    await chrome.notifications.clear(`${NUDGE_PREFIX}${tabId}`).catch(() => {});
    await safe(chrome.action.setPopup({ tabId, popup: POPUP_URL }));
    await safe(chrome.action.setBadgeText({ tabId, text: "" }));
    await safe(chrome.action.setTitle({ tabId, title: DEFAULT_TITLE }));
}

async function nudge(tabId, platform) {
    const settings = await getSettings();
    if (!settings.nudgeEnabled) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.audible || detectMeetingPlatform(tab.url)?.id !== platform.id) return;
    const banner = isPromptMeeting(tab.url) && await hasMeetingPromptAccess();
    let shouldNudge = false;
    await updateArmedTab(tabId, (entry) => {
        if (!entry || entry.nudged) return entry;
        shouldNudge = true;
        return { ...entry, nudged: true, bannerPrompt: banner, promptVisible: false };
    });
    if (!shouldNudge) return;
    if (banner) {
        await injectMeetingPrompt(tabId).catch(() => {});
        await syncMeetingBanner(tabId);
        return;
    }
    await notifyMeetingNudge(tabId, platform, settings);
}

async function notifyMeetingNudge(tabId, platform, settings) {
    await updateArmedTab(tabId, (entry) => entry ? {
        ...entry, notificationFallback: true,
    } : entry);
    const access = await hasMeetingPromptAccess();
    await notify(
        t("meetingPromptTitle", t("appName")),
        t("meetingRecordBody", platform.name) +
            (access ? "" : `\n${t("meetingPromptNotificationHint")}`),
        {
            id: `${NUDGE_PREFIX}${tabId}`,
            requireInteraction: true,
            contextMessage: effectiveNoticeText(settings),
            buttons: [
                { title: t("recordWithConsent") },
                { title: t("notNow") },
            ],
        },
    );
}

/**
 * Decide, for one tab, whether it should be armed and how. Idempotent, so it
 * is safe to call on every load, navigation and audible change.
 */
async function evaluateTab(tab) {
    if (!tab || tab.id == null) return;
    const settings = await getSettings();
    const state = await getState();
    const platform = tab.url ? detectMeetingPlatform(tab.url) : null;
    const recording = state.tabId === tab.id &&
        [STATE.recording, STATE.finalizing].includes(state.state);

    if (recording) {
        if (!platform && state.state === STATE.recording &&
            state.autoStarted
        )
            await stopRecording("meeting-ended");
        if (!platform || (state.meetingTarget && !sameMeetingTarget(state.meetingTarget, tab.url))) {
            await sendMeetingBanner(tab.id, { view: "hidden" });
        } else await syncMeetingBanner(tab.id);
        return;
    }
    const mode = platform ? effectivePlatformModes(settings)[platform.id]?.mode ?? "off" : "off";
    if (settings.dataUseAcknowledgedAt && platform && mode !== "off" && await isPaired()) {
        await arm(tab, platform, mode);
        return;
    }
    await disarm(tab.id);
    const micMissing = settings.dataUseAcknowledgedAt && !settings.micReminderDismissed &&
        (await microphonePermission()) !== "granted";
    await safe(chrome.action.setBadgeText({ tabId: tab.id, text: micMissing ? "MIC!" : "" }));
    if (micMissing)
        await safe(chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#b45309" }));
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
        await resumeTypedSetupAfterLogin(tab).catch((error) =>
            console.warn("[recorder] setup return after sign-in failed:", error),
        );
        await evaluateTab(tab);
    }

    if (changeInfo.audible === true) {
        await chrome.alarms.clear(`${ALARMS.quietPrefix}${tabId}`);
        const armed = await getArmed();
        const entry = armed[tabId];
        if (entry && !entry.nudged) {
            const platform = platformById(entry.platformId);
            if (platform) await nudge(tabId, platform);
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
    await chrome.storage.session.remove([agendaPanelKey(tabId), `agenda-match:${tabId}`]);
    await sendMeetingBanner(tabId, { view: "hidden" });
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
    if (changes.platformModes || changes.serverDefaults || changes.encryptedApiKey || changes.dataUseAcknowledgedAt
        || changes.micReminderDismissed || changes.nudgeEnabled || changes.noticeText || changes.autoModeAcknowledgedAt
    ) {
        void reevaluateAllTabs();
    }
    if (changes.agendaReminders) void (changes.agendaReminders.newValue === false
        ? clearAgendaReminders() : refreshAgendas()).catch(() => {});
    if (changes.agendaBanner) void reevaluateAllTabs();
    if (changes.encryptedApiKey || changes.serverUrl || changes.serverDefaults || changes.dataUseAcknowledgedAt) {
        void getSettings().then(async (settings) => {
            if (!supportsAgendas(settings)) await clearAgendas();
        }).catch(() => {});
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

    const entry = (await getArmed())[tab.id];
    const bannerConsent = entry?.mode === "prompt" && entry.promptVisible === true && entry.bannerPrompt === true &&
        sameMeetingTarget(entry.meetingTarget, tab.url) && await hasMeetingPromptAccess();
    if (!bannerConsent && !settings.autoModeAcknowledgedAt) {
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
            auto: entry?.mode === "auto",
            noticeAcknowledgedAt: bannerConsent ? new Date().toISOString() : settings.autoModeAcknowledgedAt,
        });
    } catch (error) {
        if (entry?.promptVisible && entry.bannerPrompt) await showMeetingBannerError(tab.id, tab.url, error);
        await notify(t("couldNotStart"), error?.message ?? String(error));
    }
}

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
    if (alarm.name.startsWith(AGENDA_ALARM_PREFIX)) {
        const id = alarm.name.slice(AGENDA_ALARM_PREFIX.length);
        const settings = await getSettings();
        if (supportsAgendas(settings) && settings.agendaBanner && await hasMeetingPromptAccess()) {
            const armed = await getArmed();
            for (const [tabId, entry] of Object.entries(armed)) {
                if (!entry.promptVisible) continue;
                const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
                if (tab && sameMeetingTarget(entry.meetingTarget, tab.url) &&
                    (await bannerAgendas(tab)).some((agenda) => agenda.id === id)) return;
            }
        }
        await remindAgenda(id).catch(() => {});
        return;
    }
    if (alarm.name === "recorder-agendas-refresh") {
        await refreshAgendas().catch(() => {});
        return;
    }
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
    await chrome.alarms.create("recorder-agendas-refresh", { periodInMinutes: 30 });
    const existing = await chrome.alarms.get(ALARMS.configRefresh);
    if (!existing) {
        await chrome.alarms.create(ALARMS.configRefresh, {
            periodInMinutes: 24 * 60,
        });
    }
}

// ---- Pairing and presence ---------------------------------------------

async function pingStatus(origin, tabId) {
    const settings = await getSettings();
    const consented = Boolean(settings.dataUseAcknowledgedAt);
    return {
        installed: true,
        version: chrome.runtime.getManifest().version,
        installationId: consented ? await getInstallationId() : undefined,
        paired: consented && Boolean(settings.serverUrl && settings.hasApiKey),
        pairedTo: consented && settings.serverUrl ? originOf(settings.serverUrl) : null,
        autoMode: consented && anyPlatformAuto(settings),
        micPermission: consented ? await microphonePermission() : undefined,
        ...(consented && await activeSetupFlow(origin, tabId) ? { setupPending: true } : {}),
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
        pingStatus(senderOrigin, sender.tab?.id).then((status) =>
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
                return queuePairing(message, senderOrigin, chrome, sender.tab?.id);
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
        withoutMicrophone: state.withoutMicrophone,
        captureMode: "desktop",
        captureWindowId: state.captureWindowId,
        pickerRequestId: state.pickerRequestId,
    }).then(() => ({ ok: true }));
}

async function resumeRecording(message, sender) {
    const request = (await chrome.storage.session.get(START_REQUEST_KEY))[
        START_REQUEST_KEY
    ];
    const expected = chrome.runtime.getURL(
        `request/request.html?requestId=${message.requestId}`,
    );
    if (
        !request ||
        request.id !== message.requestId ||
        sender.url !== expected ||
        sender.tab?.windowId !== request.windowId ||
        Date.now() - request.createdAt > START_REQUEST_TTL_MS
    ) {
        throw new Error(t("recordingRequestExpired"));
    }
    const settings = await getSettings();
    if (settings.serverUrl !== request.serverUrl)
        throw new Error(t("recordingRequestExpired"));
    if (request.input.tabId != null) {
        const tab = await chrome.tabs.get(request.input.tabId).catch(() => null);
        if (!tab) throw new Error(t("meetingTabClosed"));
        if (!sameMeetingTarget(request.tabUrl, tab.url))
            throw new Error(t("recordingRequestExpired"));
    }
    if (
        !message.withoutMicrophone &&
        (await microphonePermission()) !== "granted"
    )
        throw new Error(t("micWarning"));
    const notice =
        request.input.noticeAcknowledgedAt ?? message.noticeAcknowledgedAt;
    if (!notice || !Number.isFinite(Date.parse(notice)))
        throw new Error(t("participantAckRequired"));
    const result = await startRecording(
        {
            ...request.input,
            noticeAcknowledgedAt: notice,
            forceDesktop: true,
            withoutMicrophone: message.withoutMicrophone === true,
        },
        true,
    );
    await chrome.storage.session.remove(START_REQUEST_KEY);
    return { ok: true, ...result };
}

// ---- Internal messaging (popup, options, offscreen, content script) --------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target === "offscreen") return false;
    if (message.type === "open-agenda") {
        const extensionPage = sender.id === chrome.runtime.id &&
            [POPUP_URL, "agenda/agenda.html"].some((path) => sender.url?.split("?")[0] === chrome.runtime.getURL(path));
        const meeting = sender.id === chrome.runtime.id && sender.frameId === 0 &&
            Number.isInteger(sender.tab?.id) && isPromptMeeting(sender.url);
        if (!extensionPage && !meeting) { sendResponse({ ok: false, error: t("unrecognizedSender") }); return false; }
        const opened = openAgendaPanel({ tabId: meeting ? sender.tab.id : message.tabId, matchTabId: meeting ? sender.tab.id : message.matchTabId, windowId: message.windowId }, []);
        Promise.all([opened, resolvePanelAgenda(message, sender, meeting, opened)]).then(() => sendResponse({ ok: true }))
            .catch(() => sendResponse({ ok: false, error: t("agendaFailed") }));
        return true;
    }

    const meetingControl = sender.tab &&
        !sender.url?.startsWith(chrome.runtime.getURL("")) &&
        ["get-folders", "set-recording-folder", "stop-recording"].includes(message.type);
    if (MEETING_BANNER_MESSAGES.has(message.type) || meetingControl) {
        handleMeetingBannerMessage(message, sender).then(sendResponse).catch((error) =>
            sendResponse({ ok: false, error: error?.message ?? String(error) }),
        );
        return true;
    }
    if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL("")) &&
        ![MESSAGES.ping, MESSAGES.pair].includes(message.type)) {
        sendResponse({ ok: false, error: t("unrecognizedSender") });
        return false;
    }

    switch (message.type) {
        case "match-agendas":
        case "select-agenda":
            handleAgendaMessage(message, sender).then(sendResponse)
                .catch(() => sendResponse({ ok: false, error: t("agendaFailed") }));
            return true;
        case "resume-recording":
            resumeRecording(message, sender)
                .then(sendResponse)
                .catch((error) =>
                    sendResponse({ ok: false, error: error.message }),
                );
            return true;
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

        case "get-folders":
            getSettings()
                .then(async (settings) => {
                    const auth = {
                        serverUrl: settings.serverUrl,
                        apiKey: await readToken(),
                    };
                    if (typeof message.id === "string")
                        return getRecorderFolder(auth, message.id);
                    if (typeof message.q === "string")
                        return searchRecorderFolders(auth, message.q);
                    return [];
                })
                .then((folders) => sendResponse({ ok: true, folders }))
                .catch((error) =>
                    sendResponse({
                        ok: false,
                        status: error?.status,
                        error: error?.message ?? String(error),
                    }),
                );
            return true;

        case "set-recording-folder":
            updateRecordingFolder(message, sender)
                .then(sendResponse)
                .catch((error) => sendResponse({ ok: false, error: error.message }));
            return true;

        case "get-armed":
            getArmed().then((armed) => sendResponse({ armed }));
            return true;

        case "start-recording":
            if (sender.url !== chrome.runtime.getURL(POPUP_URL)) {
                sendResponse({ ok: false, error: t("unrecognizedSender") });
                return false;
            }
            startRecording({ ...message.payload, fromPopup: true, auto: false })
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

        case "check-finalization":
            getState()
                .then(async (state) => {
                    if (state.state !== STATE.finalizing || !state.sessionId || !state.jobId) {
                        return;
                    }
                    const settings = await getSettings();
                    await reconcileServerSession(state.sessionId, {
                        serverUrl: settings.serverUrl,
                        apiKey: await readToken(),
                    });
                })
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
            (async () => {
                const origin = originOf(sender.url);
                if (
                    origin
                        ? !(await hasPairingRelayAccess(origin))
                        : !sender.url?.startsWith(chrome.runtime.getURL(""))
                )
                    return { installed: true, unreachable: true };
                return pingStatus(origin, sender.tab?.id);
            })().then((status) =>
                sendResponse({ ...status, channel: "content" }),
            );
            return true;

        case MESSAGES.pair:
            getSettings()
                .then(async (settings) => {
                    if (!settings.dataUseAcknowledgedAt) {
                        return { ok: false, error: t("dataUseRequired") };
                    }
                    if (!(await hasPairingRelayAccess(originOf(sender.url))))
                        return { ok: false, error: t("serverAccessDenied") };
                    return queuePairing(message, originOf(sender.url ?? ""), chrome, sender.tab?.id);
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
            void handleMicrophoneFailure(message);
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

async function handleMicrophoneFailure(message) {
    const state = await getState();
    if (state.sessionId !== message.sessionId || state.state !== STATE.recording) return;
    const warning = t("micUnavailableBody", microphoneError(message.errorName));
    await setState({ micWarning: warning });
    await notify(t("micUnavailable"), warning, {
        id: `mic:${message.sessionId}`,
        requireInteraction: true,
    });
}

async function handleRecordingStopped(message) {
    const state = await getState();
    if (state.sessionId !== message.sessionId) return;
    if (state.captureMode === "desktop") {
        await setState({ stopped: true });
    } else {
        await closeOffscreen();
    }

    if (!message.chunkCount || message.chunkCount < 1) {
        await discardSession(message.sessionId);
        if (state.captureMode === "desktop" && state.captureWindowId != null) {
            await chrome.windows.remove(state.captureWindowId).catch(() => {});
        }
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
    if (state.captureMode === "desktop" && state.captureWindowId != null) {
        await chrome.windows.update(state.captureWindowId, {
            state: "normal",
            focused: true,
        }).catch(() => {});
    }
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
            await updateLocalMeta(bufferId, {
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
        await updateLocalMeta(bufferId, {
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

function recordingFolderState(meta) {
    return {
        agendaId: meta?.agendaId ?? null,
        agendaTitle: meta?.agendaTitle ?? null,
        agendaExplicit: meta?.agendaExplicit === true,
        agendaUnavailable: meta?.agendaUnavailable === true,
        folderId: meta?.folderId ?? null,
        folderLabel: meta?.folderLabel ?? null,
        startFolderId: meta?.startFolderId ?? null,
        startFolderLabel: meta?.startFolderLabel ?? null,
        recordingFolderOverride: meta?.recordingFolderOverride === true,
    };
}

async function reconcileOnStartup() {
    await unregisterPairingScripts();
    await reconcileMeetingPrompt().catch((error) =>
        console.warn("[recorder] meeting prompt registration:", error),
    );
    await ensureConfigAlarm();
    void refreshServerConfig().catch(() => {});
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
            const meta = await readLocalMeta(bufferId);
            await setState({
                ...recordingFolderState(meta),
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
                ...recordingFolderState(meta),
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
            await setState({ ...recordingFolderState(meta), sessionId: serverSessionId, bufferId: sessionId });
            await reconcileServerSession(serverSessionId, auth);
            continue;
        }
        if (session.status === "completing") {
            await setState({
                ...recordingFolderState(meta),
                state: STATE.finalizing,
                sessionId: serverSessionId,
                bufferId: sessionId,
                jobId: session.job_id,
                finalizingAt: new Date().toISOString(),
            });
            await chrome.alarms.create(ALARMS.uploadRetry, { delayInMinutes: 0.5 });
            break;
        }
        if (session.status === "aborted" || session.status === "failed") {
            try {
                session = await recoverSession(auth, serverSessionId);
                serverSessionId = session.id;
                await updateLocalMeta(sessionId, {
                    serverSessionId,
                });
            } catch (error) {
                await setState({
                    ...recordingFolderState(meta),
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
                ...recordingFolderState(meta),
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

chrome.permissions.onAdded.addListener((permissions) => {
    if (meetingPromptPermissionChanged(permissions)) void reconcileMeetingPromptAndTabs().catch((error) => console.warn("[recorder] meeting prompt registration:", error));
    void connectGrantedOrigins(permissions.origins ?? []).catch((error) =>
        console.warn("[recorder] relay registration failed:", error),
    );
});

chrome.permissions.onRemoved.addListener((permissions) => {
    if (meetingPromptPermissionChanged(permissions)) void reconcileMeetingPromptAndTabs().catch((error) => console.warn("[recorder] meeting prompt removal:", error));
    void unregisterPairingScripts().catch((error) =>
        console.warn("[recorder] relay removal failed:", error),
    );
});

chrome.runtime.onStartup.addListener(() => {
    reconcileOnStartup().catch((error) =>
        console.error("[recorder] startup reconcile failed:", error),
    );
});
chrome.runtime.onInstalled.addListener(() => {
    reconcileOnStartup().catch(() => {});
});
