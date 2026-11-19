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
// Per-tab state needed across MV3 suspension lives in chrome.storage.session.

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
    matchAgendaRoom,
    openAgendaPanel as openAgendaPanelNow,
    openAgendaWindow,
    refreshAgendas,
    remindAgenda,
    saveAgendaEdit,
    scheduleAgendaReminders,
    supportsAgendas,
    shouldLinkEditedAgenda,
} from "./lib/agendas.js";
import { sessionRoom, supportsAgendaRooms } from "./lib/agenda-rooms.js";
import { meetCode } from "./lib/meet-code.js";

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
    listRecorderFolders,
    setSessionAgenda,
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
import { createPromptIconBlink } from "./lib/prompt-icon.js";
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
import {
    connectionNotice,
    isConnectionError,
    observeConnection,
    readServerConnection,
    sameConnection,
    serverUnavailable,
    SERVER_CONNECTION_KEY,
} from "./lib/server-connection.js";
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

import { NEXT_REFRESH, NEXT_START, NEXT_END, NEXT_BADGE, NEXT_NOTICE, meetingRoom, cachedNextMeeting, clearNextMeeting, notificationMeeting, notifyNextMeeting, refreshNextMeeting, scheduleNextMeeting, updateNextMeetingBadge } from "./lib/next-meeting.js";

import { clearJoinedMeeting, joinedMeeting, joinMeeting, publishJoinedMeeting, MEETING_END_PREFIX, reconcileJoinedMeetings } from "./lib/join-meeting.js";

const joinedMeetingsLoaded = reconcileJoinedMeetings().catch(() => {});

const agendaTabs = new Map();
const openPanels = new Set();
const panelChanges = new Set();
let agendaRoutesReady = false;
const agendaRoutesLoaded = chrome.storage.session.get(null).then((stored) => {
    for (const [key, value] of Object.entries(stored)) {
        if (key.startsWith("agenda-route:")) agendaTabs.set(Number(key.slice(13)), value);
        if (key.startsWith("agenda-open:")) {
            const id = Number(key.slice(12));
            if (value === true && !panelChanges.has(id)) openPanels.add(id);
        }
    }
    const state = stored.recordingState;
    if (state?.tabId != null && state.agendaId && state.state !== "idle") agendaTabs.set(state.tabId, { agendaIds: [state.agendaId], choose: false, tabId: state.tabId, agendaSource: "recording", roomAutomatic: false });
    agendaRoutesReady = true;
    panelChanges.clear();
    return stored;
}).catch(() => false);

async function publishJoinRoute(tab, route) {
    await agendaRoutesLoaded;
    agendaTabs.set(tab.id, route);
    await safe(chrome.action.setPopup({ tabId: tab.id, popup: "" }));
}

function setAgendaPanelOpen(tabId, opened) {
    if (!agendaRoutesReady) panelChanges.add(tabId);
    if (opened) openPanels.add(tabId);
    else openPanels.delete(tabId);
    return chrome.storage.session.set({ [`agenda-open:${tabId}`]: opened });
}

function openAgendaPanel(context = {}, agendaIds = []) {
    const opened = openAgendaPanelNow(context, agendaIds);
    return opened.then(async (key) => {
        if (context.tabId != null && key === agendaPanelKey(context.tabId)) await setAgendaPanelOpen(context.tabId, true);
        return key;
    });
}

chrome.runtime.onConnect?.addListener((port) => {
    if (port.name !== "agenda-panel" || port.sender?.id !== chrome.runtime.id || port.sender.url?.split("?")[0] !== chrome.runtime.getURL("agenda/agenda.html")) return;
    const id = Number(new URL(port.sender.url).searchParams.get("tab"));
    if (!Number.isInteger(id) || !new URL(port.sender.url).searchParams.has("tab")) return;
    void setAgendaPanelOpen(id, true).catch(() => {});
    port.onDisconnect.addListener(() => { void setAgendaPanelOpen(id, false).catch(() => {}); });
});
chrome.sidePanel?.onOpened?.addListener(({ tabId }) => { if (tabId != null) void setAgendaPanelOpen(tabId, true).catch(() => {}); });
chrome.sidePanel?.onClosed?.addListener(({ tabId }) => { if (tabId != null) void setAgendaPanelOpen(tabId, false).catch(() => {}); });

async function closeAgendaPanel(tabId) {
    await setAgendaPanelOpen(tabId, false);
    if (chrome.sidePanel.close) await chrome.sidePanel.close({ tabId });
    else {
        await chrome.sidePanel.setOptions({ tabId, enabled: false });
        await chrome.sidePanel.setOptions({ tabId, path: `agenda/agenda.html?tab=${tabId}`, enabled: true });
    }
}

async function routeAgendaTab(tab, settings, state, matches) {
    await agendaRoutesLoaded;
    const target = JSON.stringify(meetingTarget(tab.url));
    let binding = await joinedMeeting(tab, settings);
    let rows = supportsAgendas(settings) && !binding ? matches ?? await bannerAgendas(tab) : [];
    const freshTab = await chrome.tabs.get(tab.id).catch(() => null);
    if (!freshTab || JSON.stringify(meetingTarget(freshTab.url)) !== target) return agendaTabs.has(tab.id);
    if (!binding) {
        binding = await joinedMeeting(freshTab, settings);
        if (binding) rows = [];
    }
    const recordingAgenda = state.tabId === tab.id && state.agendaId && state.state !== STATE.idle ? state.agendaId : null;
    const id = binding?.agendaId ?? recordingAgenda ?? (rows.length === 1 ? rows[0].id : null);
    const agendaSource = binding?.agendaId ? "join" : recordingAgenda ? "recording" : "automatic";
    const room = supportsAgendaRooms(settings) && meetCode(tab.url) ? (await chrome.storage.session.get(`agenda-match:${tab.id}`))[`agenda-match:${tab.id}`] : null;
    const roomState = room?.serverUrl === settings.serverUrl && room.connectionId === settings.connectionId && room.target === JSON.stringify(meetingTarget(tab.url)) && (Date.now() - room.at < 60000 || await serverUnavailable(settings)) && (room.restricted || room.invitations?.length);
    if (id || rows.length || roomState) {
        const route = { agendaIds: id ? [id] : rows.map((row) => row.id), choose: !id && !roomState, tabId: tab.id, agendaSource, ...(supportsAgendaRooms(settings) && meetCode(tab.url) ? { roomAutomatic: agendaSource === "automatic" } : {}) };
        agendaTabs.set(tab.id, route);
        await chrome.storage.session.set({ [`agenda-route:${tab.id}`]: route });
        await safe(chrome.action.setPopup({ tabId: tab.id, popup: "" }));
        return true;
    }
    const previous = agendaTabs.delete(tab.id);
    if (previous) await safe(chrome.action.setPopup({ tabId: tab.id, popup: POPUP_URL }));
    await chrome.storage.session.remove(`agenda-route:${tab.id}`);
    return false;
}

const STATE_KEY = "recordingState";
const ARMED_KEY = "armedTabs";
const OFFSCREEN_URL = "offscreen/offscreen.html";
const POPUP_URL = "popup/popup.html";
const DEFAULT_TITLE = t("extensionName");
const OPFS_WARN_BYTES = 1024 * 1024 * 1024; // 1 GiB of unsent audio.
const NUDGE_PREFIX = "nudge:";
const promptIcon = createPromptIconBlink(agendaRoutesLoaded, clearPromptBlinkCopy);
const COMPLETION_PREFIX = "completed:";
const COMPLETION_DISPLAY_MS = 3500;
const CONNECTION_ALARM = "recorder-connection-probe";
const METADATA_DRAIN_MS = 10_000;
const CONNECTION_PAGES = [POPUP_URL, "agenda/agenda.html", "options/options.html", "picker/picker.html"];
let connectionUpdates = Promise.resolve();
let connectionProbe;
let startupReconciliation;

observeConnection(queueConnectionOutcome);

function queueConnectionOutcome(outcome) {
    const update = connectionUpdates.catch(() => {}).then(() => updateServerConnection(outcome));
    connectionUpdates = update;
    return update;
}

async function updateServerConnection({ config, ...outcome }) {
    const settings = await getSettings();
    if (!settings.dataUseAcknowledgedAt || !settings.hasApiKey || !sameConnection(settings, outcome)) return;
    const previous = await readServerConnection(settings);
    if (previous && previous.checkedAt > outcome.checkedAt) return;
    const configError = config && outcome.state === "ok" ? outcome.configError : previous?.configError;
    const changed = previous?.state !== outcome.state ||
        previous?.configError !== configError ||
        JSON.stringify(previous?.detail) !== JSON.stringify(outcome.detail);
    await chrome.storage.session.set({
        [SERVER_CONNECTION_KEY]: {
            ...outcome,
            ...(configError ? { configError } : {}),
        },
    });
    if (outcome.state !== "ok") {
        void ensureConnectionAlarm().catch(() => {});
        if (changed) void syncConnectionBanners().catch(() => {});
        return;
    }
    if (configError && changed) {
        void ensureConnectionAlarm().catch(() => {});
        void syncConnectionBanners().catch(() => {});
    }
    if (previous && (previous.state !== "ok" || (previous.configError && !configError))) {
        const probe = connectionProbe ?? (config || configError ? null : probeConnection());
        void Promise.resolve(probe).catch(() => {}).then(() => recoverConnection(settings)).catch(() => {});
    }
}

async function syncConnectionBanners() {
    const [armed, state] = await Promise.all([getArmed(), getState()]);
    const tabs = new Set(Object.keys(armed).map(Number));
    if (state.tabId != null) tabs.add(state.tabId);
    await Promise.all([...tabs].map((tabId) => syncMeetingBannerNow(tabId, true)));
}

async function connectionHasWaiters() {
    const [state, armed, contexts] = await Promise.all([
        getState(),
        getArmed(),
        chrome.runtime.getContexts?.({ contextTypes: ["POPUP", "SIDE_PANEL", "TAB"] }) ?? [],
    ]);
    return Boolean((state.sessionId && state.state !== STATE.completed) ||
        Object.values(armed).some((entry) => entry.bannerPrompt || entry.promptVisible || entry.bannerError) ||
        contexts.some(({ documentUrl }) => CONNECTION_PAGES.some((path) => isExtensionPage(documentUrl, path))));
}

async function needsConnectionProbe() {
    const connection = await readServerConnection();
    return Boolean(connection && (connection.state !== "ok" || connection.configError));
}

async function ensureConnectionAlarm() {
    if (!(await needsConnectionProbe()) || !(await connectionHasWaiters())) return;
    if (!(await chrome.alarms.get(CONNECTION_ALARM))) {
        await chrome.alarms.create(CONNECTION_ALARM, { periodInMinutes: 0.5 });
    }
}

function probeConnection() {
    connectionProbe ??= refreshServerConfig().finally(() => { connectionProbe = null; });
    return connectionProbe;
}

async function recoverConnection(expected) {
    await startupReconciliation?.catch(() => {});
    const settings = await getSettings();
    if (!settings.dataUseAcknowledgedAt || !settings.hasApiKey || !sameConnection(expected, settings)) return;
    const connection = await readServerConnection(settings);
    if (connection?.state !== "ok") return;
    if (!connection.configError) await chrome.alarms.clear(CONNECTION_ALARM);
    const state = await getState();
    const upload = async () => {
        if (state.sessionId && state.state !== STATE.completed) {
            await transitionBuffer(async () => {
                const current = await getState();
                if (!sameUploadOwner(current, state)) return;
                const bufferId = current.bufferId ?? current.sessionId;
                if (!(await readLocalMeta(bufferId))) return;
                await updateLocalMeta(bufferId, { retryAttempt: 0, nextRetryAt: null });
                await setState({ uploadNotice: current.blocked && !current.stopped ? current.uploadNotice : null });
                if (current.reconcilePending) await reconcileBufferedRecordingsOnce();
                else if (!current.blocked) await resumeUploadWork();
            });
        }
    };
    await Promise.allSettled([
        upload(),
        ...(!connection.configError ? [
            refreshNextMeeting({ force: true }),
            refreshAgendas({ force: true }),
        ] : []),
        syncConnectionBanners(),
    ]);
}

function isPollingFinalization(state) {
    return state.state === STATE.finalizing && Boolean(state.serverCompleting || state.jobId);
}

async function resumeUploadWork() {
    const state = await getState();
    if (await serverUnavailable()) return;
    if (state.reconcilePending) return reconcileBufferedRecordings();
    if (state.sessionId && isPollingFinalization(state)) {
        const settings = await getSettings();
        await pollFinalization(state, {
            serverUrl: settings.serverUrl,
            connectionId: settings.connectionId,
            apiKey: await readToken(),
        });
    } else {
        await pumpUploads();
    }
}

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
    folderScope: null,
    recordingFolderOverride: false,
    tabId: null,
    autoStarted: false,
    chunkCount: 0,
    stopped: false,
    stopReason: "user",
    uploaded: [],
    blocked: false,
    reconcilePending: false,
    truncatedAtChunk: null,
    startConnectionError: false,
    connecting: false,
    uploadNotice: null,
    recoverablePrefix: null,
    jobId: null,
    serverCompleting: false,
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

function setState(patch, owner) {
    const update = stateUpdates.catch(() => {}).then(() => writeState(patch, owner));
    stateUpdates = update;
    return update;
}

async function writeState(patch, owner) {
    const current = await getState();
    if (owner && !sameUploadOwner(current, owner)) return;
    const next = { ...current, ...patch };
    await chrome.storage.session.set({ [STATE_KEY]: next });
    chrome.runtime.sendMessage({ type: "state", state: next }).catch(() => {});
    await updateRecordingBadge(next);
    if ("reconcilePending" in patch && patch.reconcilePending) void ensureConnectionAlarm().catch(() => {});
    if (["state", "tabId", "stopped"].some((key) => key in patch)) void updateNextMeetingBadge().catch(() => {});
    const bannerFields = [
        "state", "tabId", "startedAt", "stopped", "folderId", "folderLabel", "folderScope",
        "recordingFolderOverride", "error", "agendaId", "uploadNotice", "connecting",
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
    await updateNextMeetingBadge().catch(() => {});
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
        !isLiveCapture(state)
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
        state.state !== STATE.awaitingPicker && !isLiveCapture(state)
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
    if (starting || bufferTransitionCount) throw new Error(t("alreadyInProgress"));
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
    folderScope,
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
    try {
        await prepareRecordingAgenda(tabId, fromPopup ? agendaId : bannerAgendaId);
    } catch (error) {
        if (!isConnectionError(error)) throw error;
    }
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
        startConnectionError: false,
        micWarning: null,
        meetingBannerErrorDismissed: false,
        popupFolder: fromPopup && folderId !== undefined ? { folderId, folderLabel: folderLabel ?? null, folderScope: folderScope ?? null } : null,
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
    const connecting = await serverUnavailable(settings);
    if (settings.serverDefaults?.encryptedRecordingProtocol !== 1 && !connecting) {
        await setState({ state: STATE.error, error: t("encryptedServerRequired") });
        throw new Error(t("encryptedServerRequired"));
    }
    const auth = { serverUrl: settings.serverUrl, connectionId: settings.connectionId, apiKey: apiKey ?? await readToken() };
    const startedAt = new Date().toISOString();
    const clientRecordingId = crypto.randomUUID();
    const channelLayout =
        settings.channelMode === "split"
            ? CHANNEL_LAYOUT_SPLIT
            : CHANNEL_LAYOUT_MIXED;

    const sessionBody = {
        ...sessionRoom(settings, tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null),
        clientRecordingId,
        mimeType: SESSION_MIME_TYPE,
        channelLayout,
        startedAt,
        platformHint: platformHint ?? undefined,
        clientVersion: chrome.runtime.getManifest().version,
        timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
        noticeAcknowledgedAt: noticeAcknowledgedAt ?? startedAt,
        folderId: "folderId" in selectedFolder ? selectedFolder.folderId ?? undefined : settings.folderId ?? undefined,
        ...(settings.serverDefaults?.sessionAgenda === true && selectedAgenda?.permissions?.edit !== false && selectedAgenda ? { agendaId: selectedAgenda.id } : {}),
    };
    if (connecting) await setState({ connecting: true });
    let session;
    let folderId = "folderId" in selectedFolder ? selectedFolder.folderId : settings.folderId ?? null;
    let folderLabel = "folderId" in selectedFolder ? selectedFolder.folderLabel ?? null : settings.folderLabel ?? null;
    let folderScope = "folderId" in selectedFolder ? selectedFolder.folderScope ?? null : settings.folderScope ?? null;
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
                folderScope = null;
                if (!selectedFolder.folderId) await saveSettings({ folderId, folderLabel, folderScope });
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
            const connectionFailed = isConnectionError(error);
            await setState({
                state: STATE.error,
                connecting: false,
                startConnectionError: connectionFailed,
                error: connectionFailed ? null : error?.message ?? String(error),
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
            agendaOwn: selectedAgenda?.own === true,
            agendaExplicit,
            agendaUnavailable: false,
            folderId,
            folderLabel,
            folderScope,
            startFolderScope: folderScope,
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
            connecting: false,
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
            serverCompleting: false,
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
                connecting: false,
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
                connecting: false,
                error: error?.message ?? String(error),
            });
        }
        if (captureMode === "desktop") {
            await chrome.windows.remove(captureWindowId).catch(() => {});
        }
        throw error;
    }
}

function isLiveCapture(state) {
    return Boolean(state.sessionId && !state.stopped &&
        (state.state === STATE.recording || state.captureMode === "tab" ||
            (state.captureMode === "desktop" && state.captureWindowId != null)));
}

async function stopRecording(reason = "user", expected = null) {
    const state = await getState();
    if (expected && (state.tabId !== expected.tabId || state.sessionId !== expected.sessionId)) throw new Error(t("unrecognizedSender"));
    if (!isLiveCapture(state)) return { ok: true };
    if (state.tabId != null) {
        await chrome.alarms.clear(`${ALARMS.quietPrefix}${state.tabId}`);
    }
    await setState({ stopReason: reason });
    const desktop = state.captureMode === "desktop";
    const response = await (desktop
        ? messageDesktop("stop", state.pickerRequestId)
        : messageOffscreen("stop")).catch(() => null);
    if (response?.ok === true) return { ok: true };
    if (desktop) {
        await reconcileDesktopWindow();
        if (!isLiveCapture(await getState())) return { ok: true };
    }
    return { ok: false, error: response?.error || t("somethingWrong") };
}

let metaUpdates = Promise.resolve();
let recordingMetadataUpdates = Promise.resolve();

function updateLocalMeta(bufferId, patch, owner) {
    const update = metaUpdates.catch(() => {}).then(async () => {
        const meta = await readLocalMeta(bufferId);
        if (!meta) throw new Error(t("recoveryUnavailable"));
        const { agendaTitle: _title, ...persistentPatch } = patch;
        const { agendaTitle: _previousTitle, ...persistentMeta } = meta;
        const next = { ...persistentMeta, ...persistentPatch };
        if (owner) {
            if (!sameUploadOwner(await getState(), owner)) return false;
            await createLocalSession(bufferId, next, { create: false });
        } else {
            await createLocalSession(bufferId, next);
        }
        return true;
    });
    metaUpdates = update;
    return update;
}

async function applyRecordingFolder(state, folder, remember = true) {
    if (!(await updateLocalMeta(state.bufferId ?? state.sessionId, folder, state)) ||
        !(await setState(folder, state))) return false;
    if (remember) await saveSettings(folder);
    return true;
}

function updateRecordingFolder(message, sender) {
    const requestedState = getState().catch(() => null);
    const update = recordingMetadataUpdates.then(async () => {
        const state = await getState();
        const popup = [POPUP_URL, "agenda/agenda.html"].some((path) => sender.url?.split("?")[0] === chrome.runtime.getURL(path));
        const pickerUrl = chrome.runtime.getURL("picker/picker.html");
        const picker = Boolean(sender.url?.startsWith(`${pickerUrl}?`)) &&
            state.pickerRequestId != null &&
            new URL(sender.url).searchParams.get("requestId") === state.pickerRequestId &&
            sender.tab?.windowId === state.captureWindowId;
        if (!popup && !picker && !(await validMeetingBannerSender(sender, state))) throw new Error(t("unrecognizedSender"));
        const settings = await getSettings();
        if (state.sessionId !== message.sessionId || state.state !== STATE.recording ||
            !wasQueuedDuringCapture(await requestedState, state) || !state.recordingFolderOverride ||
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
            folderScope: message.folderId && ["personal", "org"].includes(message.folderScope) ? message.folderScope : null,
        };
        if (!(await applyRecordingFolder(state, folder, message.remember !== false))) throw new Error(t("folderChangeFailed"));
        return { ok: true };
    });
    recordingMetadataUpdates = update.catch(() => {});
    return update;
}

// ---- Upload pump -------------------------------------------------------

let uploadPump = null;
let pumpRequested = false;

function pumpUploads() {
    pumpRequested = true;
    if (bufferTransitionCount) return uploadPump ?? Promise.resolve();
    if (!uploadPump) {
        uploadPump = (async () => {
            try {
                do {
                    pumpRequested = false;
                    await pumpUploadsOnce();
                } while (pumpRequested && !bufferTransitionCount);
            } finally {
                uploadPump = null;
            }
        })();
    }
    return uploadPump;
}

async function healStoppedUpload() {
    const state = await getState();
    if (
        !state.sessionId || !state.stopped || state.blocked ||
        !(state.state === STATE.recording || (state.state === STATE.finalizing && !isPollingFinalization(state)))
    ) return false;
    await pumpUploads();
    return true;
}

async function pumpUploadsOnce() {
    try {
        for (;;) {
            const state = await getState();
            if (!canPumpUploads(state) || state.reconcilePending || await serverUnavailable()) break;
            if (state.stopped && state.truncatedAtChunk) {
                await finalize(state.truncatedAtChunk);
                break;
            }
            const settings = await getSettings();
            const auth = {
                serverUrl: settings.serverUrl,
                connectionId: settings.connectionId,
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
                    if (!sameUploadOwner(now, state)) return;
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
                    if (!sameUploadOwner(await getState(), state)) return;
                    if (error?.status && ![429, 500, 502, 503, 504].includes(error.status)) {
                        await setState({
                            ...(isLiveCapture(await getState())
                                ? { uploadNotice: retryErrorMessage(error) }
                                : { state: STATE.error, error: retryErrorMessage(error) }),
                            blocked: true,
                            recoverablePrefix: [409, 413, 422].includes(error.status) && index > 0 ? index : null,
                        });
                    } else {
                        await setState({ uploadNotice: isConnectionError(error) ? null : retryErrorMessage(error) });
                        await scheduleUploadRetry(state.bufferId ?? state.sessionId, error);
                    }
                    break;
                }
            }
            if (!progressed) break;
        }
    } catch (error) {
        const state = await getState();
        const message = error?.message ?? t("recoveryUnavailable");
        await setState(isLiveCapture(state)
            ? { blocked: true, uploadNotice: message }
            : { state: STATE.error, blocked: true, error: message });
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

function sameUploadOwner(current, expected) {
    return current.sessionId === expected.sessionId &&
        (current.bufferId ?? current.sessionId) === (expected.bufferId ?? expected.sessionId);
}

function wasQueuedDuringCapture(requested, current) {
    return requested?.state === STATE.recording && !requested.stopped && sameUploadOwner(current, requested);
}

let finalization = null;

function finalize(truncatedAtChunk = null) {
    if (!finalization) {
        finalization = finalizeOnce(truncatedAtChunk).finally(() => {
            finalization = null;
        });
    }
    return finalization;
}

async function finalizeOnce(truncatedAtChunk) {
    const state = await getState();
    if (!state.sessionId || !state.stopped) return;
    if (isPollingFinalization(state)) return;
    const metadata = recordingMetadataUpdates;
    let timer;
    const drained = await Promise.race([
        metadata.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), METADATA_DRAIN_MS); }),
    ]);
    clearTimeout(timer);
    if (!drained) {
        await ensureUploadRetryAlarm();
        void metadata.then(pumpUploads).catch(() => {});
        return;
    }
    const ready = await getState();
    if (!sameUploadOwner(ready, state)) return;

    await setState({
        state: STATE.finalizing,
        finalizingAt: new Date().toISOString(),
    });
    try {
        const settings = await getSettings();
        const auth = { serverUrl: settings.serverUrl, connectionId: settings.connectionId, apiKey: await readToken() };
        const body = {
            chunkCount: state.chunkCount,
            ...(truncatedAtChunk ? { truncatedAtChunk } : {}),
            endedAt: new Date().toISOString(),
            stopReason: state.stopReason,
            ...agendaCompletion(settings, ready),
            ...(settings.serverDefaults?.recordingFolderOverride === true &&
                ready.recordingFolderOverride === true
                ? { folderId: ready.folderId ?? null }
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
                if (!sameUploadOwner(await getState(), state)) return;
                await applyRecordingFolder(state, {
                    folderId: state.startFolderId ?? null,
                    folderLabel: state.startFolderLabel ?? null,
                    folderScope: state.startFolderScope ?? null,
                }, !ready.agendaExplicit || !ready.agendaId);
            } else {
                throw error;
            }
        }
        if (!sameUploadOwner(await getState(), state)) return;
        const agendaUnavailable = result.agenda?.attached === false && result.agenda.reason === "unavailable";
        if (agendaUnavailable) await updateLocalMeta(state.bufferId ?? state.sessionId, { agendaUnavailable });
        await setState({
            jobId: result.job_id ?? null,
            serverCompleting: result.status === "completing" || result.status === "completed",
            agendaUnavailable,
        });

        await pollFinalization(state, auth);
    } catch (error) {
        if (!sameUploadOwner(await getState(), state)) return;
        const blocked = Boolean(error?.status && ![429, 500, 502, 503, 504].includes(error.status));
        if (!isConnectionError(error)) {
            await setState({
                state: STATE.error,
                blocked,
                error: retryErrorMessage(error, t("finalizeFailed")),
            });
        }
        if (!blocked) await scheduleUploadRetry(state.bufferId ?? state.sessionId, error);
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

async function ensureUploadRetryAlarm(delayInMinutes = 0.5) {
    const existing = await chrome.alarms.get(ALARMS.uploadRetry);
    if (existing && existing.scheduledTime <= Date.now() + delayInMinutes * 60000) return;
    await chrome.alarms.create(ALARMS.uploadRetry, { delayInMinutes });
}

async function pollFinalization(state, auth) {
    try {
        await reconcileServerSession(state.sessionId, auth);
    } catch (error) {
        const current = await getState();
        if (!sameUploadOwner(current, state) || current.state !== STATE.finalizing) return;
        if (error?.status && ![429, 500, 502, 503, 504].includes(error.status)) {
            await setState({
                state: STATE.error,
                blocked: true,
                error: retryErrorMessage(error, t("finalizeFailed")),
            });
        } else if (isConnectionError(error)) {
            await ensureConnectionAlarm();
        } else {
            await setState({ uploadNotice: retryErrorMessage(error, t("finalizeFailed")) });
            await ensureUploadRetryAlarm(Math.max(1, (error?.retryAfterSeconds ?? 0) / 60));
        }
    }
}

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
    const state = await getState();
    if (state.sessionId !== sessionId || state.state === STATE.completed) return;
    if (remote.status === "completing") {
        const jobId = remote.job_id ?? state.jobId ?? null;
        if (!state.serverCompleting || state.jobId !== jobId || state.uploadNotice)
            await setState({ serverCompleting: true, jobId, uploadNotice: null });
        await ensureUploadRetryAlarm();
        return;
    }
    if (remote.status === "completed") {
        if (typeof remote.recording_id !== "string" || !remote.recording_id.trim()) {
            await setState({
                state: STATE.error,
                blocked: true,
                error: "Server confirmed completion without a recording ID",
            });
            return;
        }
        const url = new URL("/dashboard", auth.serverUrl);
        url.searchParams.set("recording", remote.recording_id);
        const recordingUrl = url.href;
        await safe(deleteLocalSession(state.bufferId ?? sessionId));
        await setState({
            state: STATE.completed,
            uploadNotice: null,
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
    if (!sameConnection(cached, settings) || cached.target !== JSON.stringify(meetingTarget(tab.url))) return [];
    if (await serverUnavailable(settings)) return cached.agendas;
    return cached.agendas.filter(row => (supportsAgendaRooms(settings) && row.roomBound) || currentAgendas([row]).length);
}

async function bannerAgendas(tab, { strict = false } = {}) {
    const key = `agenda-match:${tab.id}`;
    const target = JSON.stringify(meetingTarget(tab.url));
    const cached = (await chrome.storage.session.get(key))[key];
    const settings = await getSettings();
    if (!strict && (await serverUnavailable(settings) ||
        (sameConnection(cached, settings) && cached.target === target && Date.now() - cached.at < 60000))) {
        return cachedBannerAgendas(tab, settings);
    }
    try {
        const room = await matchAgendaRoom(tab.url, Date.now(), {}, { timeoutMs: strict ? 10000 : 1000 });
        const freshTab = await chrome.tabs.get(tab.id).catch(() => null);
        if (freshTab && JSON.stringify(meetingTarget(freshTab.url)) === target)
            await chrome.storage.session.set({ [key]: { target, serverUrl: settings.serverUrl, connectionId: settings.connectionId, at: Date.now(), agendas: room.data, restricted: room.restricted, invitations: room.invitations } });
        return room.data;
    } catch (error) {
        if (strict) throw error;
        return isConnectionError(error) ? cachedBannerAgendas(tab, settings) : [];
    }
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
    let agenda = shown ? matches.find((row) => row.id === shown) : null;
    if (!agenda && shown && !(await serverUnavailable(settings))) {
        const loaded = await agendaRequest(`/${encodeURIComponent(shown)}`);
        if (loaded.permissions?.edit) agenda = { ...loaded, start: loaded.plannedStart, end: loaded.plannedEnd };
    }
    if (!agenda && shownAgendaId !== null) {
        await chrome.storage.session.remove(AGENDA_SELECTION_KEY);
        return;
    }
    await chrome.storage.session.set({ [AGENDA_SELECTION_KEY]: {
        serverUrl: settings.serverUrl, connectionId: settings.connectionId, target, at: Date.now(), agenda: agenda ?? null, explicit: true,
    } });
}

function handleAgendaMessage(message, sender) {
    if (!["select-agenda", "edit-agenda"].includes(message.type)) return handleAgendaMessageNow(message, sender);
    const requestedState = message.sessionId ? getState().catch(() => null) : null;
    const update = recordingMetadataUpdates.then(async () => handleAgendaMessageNow(message, sender, await requestedState));
    recordingMetadataUpdates = update.catch(() => {});
    return update;
}

async function handleAgendaMessageNow(message, sender, requestedState = null) {
    if (sender.id !== chrome.runtime.id ||
        ![POPUP_URL, "agenda/agenda.html"].some((path) => sender.url?.split("?")[0] === chrome.runtime.getURL(path))) throw new Error(t("unrecognizedSender"));
    const settings = await getSettings();
    if (!supportsAgendas(settings)) return { ok: true, agendas: [] };
    const tab = message.tabId != null ? await chrome.tabs.get(message.tabId).catch(() => null) : null;
    if (["room-presence", "room-agendas"].includes(message.type)) {
        if (sender.url?.split("?")[0] !== chrome.runtime.getURL("agenda/agenda.html") || !supportsAgendaRooms(settings) || !meetCode(tab?.url)) return { ok: true, data: [], restricted: false, invitations: [] };
        if (message.type === "room-presence") {
            if (await serverUnavailable(settings)) return { ok: true, retryAfterMs: 30000 };
            const panelTab = new URL(sender.url).searchParams.get("tab");
            if ((panelTab !== null && !openPanels.has(Number(panelTab))) || message.roomCode !== meetCode(tab.url)) return { ok: true };
            const result = await agendaRequest("/presence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ meetCode: meetCode(tab.url), agendaId: message.agendaId ?? null }) });
            return { ok: true, ...result };
        }
        const code = meetCode(tab.url);
        const room = await matchAgendaRoom(tab.url);
        const latestTab = await chrome.tabs.get(tab.id).catch(() => null);
        if (meetCode(latestTab?.url) !== code) return { ok: true, data: [], restricted: false, invitations: [] };
        await chrome.storage.session.set({ [`agenda-match:${tab.id}`]: { target: JSON.stringify(meetingTarget(tab.url)), serverUrl: settings.serverUrl, connectionId: settings.connectionId, at: Date.now(), agendas: room.data, restricted: room.restricted, invitations: room.invitations } });
        await routeAgendaTab(tab, settings, await getState(), room.data);
        return { ok: true, ...room };
    }
    if (message.type === "match-agendas") {
        void refreshAgendas({ force: true }).catch(() => {});
        const binding = await joinedMeeting(tab, settings);
        const agendas = binding ? (binding.agendaId ? [await agendaRequest(`/${encodeURIComponent(binding.agendaId)}`)] : []) : tab ? await bannerAgendas(tab, { strict: true }) : await matchAgendas();
        const selected = (await chrome.storage.session.get(AGENDA_SELECTION_KEY))[AGENDA_SELECTION_KEY];
        const target = JSON.stringify(meetingTarget(tab?.url));
        const hasSelection = selected?.serverUrl === settings.serverUrl && selected.connectionId === settings.connectionId && selected.explicit &&
            (selected.target === target || selected.target === "null") && Date.now() - selected.at < 15 * 60000;
        return { ok: true, agendas, ...(binding ? { selectedAgenda: agendas[0] ?? null } : hasSelection ? { selectedAgenda: selected.agenda } : {}) };
    }
    const edit = message.type === "edit-agenda" ? message.edit : null;
    let saved;
    if (edit) {
        if (!isExtensionPage(sender.url, "agenda/agenda.html") ||
            typeof message.agendaId !== "string" || !message.agendaId ||
            typeof edit.path !== "string" || !edit.body || typeof edit.body !== "object")
            throw new Error(t("agendaFailed"));
        saved = await saveAgendaEdit(message.agendaId, edit.path, edit.body);
        const state = await getState();
        const canLink = state.agendaId
            ? state.agendaId !== message.agendaId && !state.agendaOwn
            : !state.agendaExplicit;
        if (!canLink || !wasQueuedDuringCapture(requestedState, state) ||
            message.sessionId !== state.sessionId || message.tabId !== state.tabId) return { ok: true, saved };
    }
    try {
        const agenda = await linkRecordingAgenda(message, settings, tab, requestedState);
        return { ok: true, agenda, saved };
    } catch (error) {
        if (!edit) throw error;
        return { ok: true, saved, linkError: t("agendaFailed") };
    }
}

async function linkRecordingAgenda(message, settings, tab, requestedState) {
    let agenda = null;
    if (message.agendaId != null) {
        agenda = await agendaRequest(`/${encodeURIComponent(message.agendaId)}`);
        if (!agenda.permissions?.edit) throw new Error(t("agendaFailed"));
        agenda = { ...agenda, start: agenda.plannedStart, end: agenda.plannedEnd };
    }
    const state = await getState();
    if (message.sessionId) {
        const metadataState = state.stopped && wasQueuedDuringCapture(requestedState, state) &&
            (state.state === STATE.recording || (state.state === STATE.error && state.blocked))
            ? { ...state, state: STATE.recording, stopped: false } : state;
        if (state.sessionId !== message.sessionId || !canChooseRecordingAgenda(metadataState)) throw new Error(t("agendaFailed"));
        if (message.type === "edit-agenda" && (message.tabId !== state.tabId || !shouldLinkEditedAgenda(metadataState, agenda))) return agenda;
        const announce = settings.serverDefaults?.sessionAgenda === true && metadataState.state === STATE.recording;
        const announceAgenda = async () => setSessionAgenda({ serverUrl: settings.serverUrl, connectionId: settings.connectionId, apiKey: await readToken() }, state.sessionId, agenda?.id ?? null);
        if (announce && !message.edit) await announceAgenda();
        const patch = { agendaId: agenda?.id ?? null, agendaTitle: agenda?.title ?? null, agendaOwn: agenda?.own === true, agendaExplicit: true,
            folderId: settings.folderId, folderLabel: settings.folderLabel, folderScope: settings.folderScope,
            ...agendaFolder(agenda) };
        if (!(await updateLocalMeta(state.bufferId ?? state.sessionId, patch, state)) ||
            !(await setState(patch, state))) throw new Error(t("agendaFailed"));
        if (announce && message.edit && !state.stopped) await announceAgenda();
    } else {
        const target = JSON.stringify(meetingTarget(tab?.url));
        await chrome.storage.session.set({ [AGENDA_SELECTION_KEY]: { serverUrl: settings.serverUrl, connectionId: settings.connectionId, target, at: Date.now(), agenda, explicit: true } });
    }
    if (message.type === "select-agenda" && tab) {
        const binding = await joinedMeeting(tab, settings);
        if (binding) await chrome.storage.session.set({ [`meeting-tab:${tab.id}`]: { ...binding, agendaId: agenda?.id ?? null } });
    }
    return agenda;
}

async function resolvePanelAgenda(message, sender, meeting, opened) {
    if (meeting && !(await validMeetingBannerSender(sender))) throw new Error(t("unrecognizedSender"));
    const settings = await getSettings();
    if (!supportsAgendas(settings) || (meeting && !settings.agendaBanner)) throw new Error(t("agendaUnsupported"));
    const state = await getState();
    const panelTabId = meeting ? sender.tab.id : message.tabId;
    const tabId = meeting ? panelTabId : message.matchTabId ?? panelTabId;
    const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
    const binding = await joinedMeeting(tab, settings);
    const matches = binding?.agendaId || message.agendaId ? [] : tab ? await bannerAgendas(tab, { strict: true }) : await matchAgendas();
    const id = message.choose ? null : message.agendaId || binding?.agendaId || (state.tabId === tabId ? state.agendaId : null) || (matches.length === 1 ? matches[0].id : null);
    const key = await opened;
    const agendaSource = id && binding?.agendaId === id ? "join" : id && state.tabId === tabId && state.agendaId === id ? "recording" : "automatic";
    await chrome.storage.session.set({ [key]: { agendaIds: id ? [id] : matches.map((row) => row.id), choose: !id, tabId, agendaSource, roomAutomatic: agendaSource === "automatic" } });
    if (panelTabId != null && key === agendaPanelKey(panelTabId) && !(await chrome.tabs.get(panelTabId).catch(() => null))) await chrome.storage.session.remove(key);
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
    if (notificationId.startsWith(NEXT_NOTICE)) {
        await joinMeeting(() => notificationMeeting(notificationId), publishJoinRoute).catch(() => {});
        await chrome.notifications.clear(notificationId);
        return;
    }
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
    if (id.startsWith(NEXT_NOTICE)) {
        if (button === 0) {
            void joinMeeting(() => notificationMeeting(id), publishJoinRoute).then(() => chrome.notifications.clear(id)).catch(() => {});
            return;
        }
        void notificationMeeting(id).then(async (meeting) => {
            if (!meeting) return;
            if (button === 1 && meeting.agendaId) await openAgendaPanel({}, [meeting.agendaId]);

            await chrome.notifications.clear(id);
        }).catch(() => {});
        return;
    }
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
const bannerSyncs = new Map();
let pinGeneration = 0;

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

function stopPromptIcon(tabId, updateCopy = false) {
    bannerSyncs.delete(tabId);
    void promptIcon.stop(tabId, updateCopy);
}

function clearPromptBlinkCopy(tabId, blinkUntil) {
    return chrome.tabs.sendMessage(tabId, { type: "meeting-banner-blink-stopped", blinkUntil }, { frameId: 0 }).catch(() => {});
}

async function sendMeetingBanner(tabId, payload, isCurrent) {
    if (payload.view !== "prompt") stopPromptIcon(tabId);
    try {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (isCurrent && !isCurrent()) return null;
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
    await safe(chrome.action.setPopup({ tabId, popup: agendaTabs.has(tabId) || entry?.mode === "auto" ? "" : POPUP_URL }));
}

async function showMeetingBannerError(tabId, meetingUrl, error) {
    if (isConnectionError(error)) {
        await syncMeetingBannerNow(tabId, true);
        return;
    }
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
    const generation = {};
    bannerSyncs.set(tabId, generation);
    const isCurrent = () => bannerSyncs.get(tabId) === generation;
    try {
        await renderMeetingBanner(tabId, cachedOnly, isCurrent);
    } finally {
        if (isCurrent()) bannerSyncs.delete(tabId);
    }
}

async function renderMeetingBanner(tabId, cachedOnly, isCurrent) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const settings = await getSettings();
    const connection = await readServerConnection(settings);
    const disconnected = connection && connection.state !== "ok";
    const enabled = tab && isPromptMeeting(tab.url) && settings.dataUseAcknowledgedAt &&
        await isPaired() && await hasMeetingPromptAccess();
    const binding = await joinedMeeting(tab, settings);
    const agendas = enabled && supportsAgendas(settings) && settings.agendaBanner
        ? binding ? (binding.agendaId ? [{ id: binding.agendaId, title: (await cachedNextMeeting())?.data?.title ?? t("agendaTitle") }] : [])
            : cachedOnly ? await cachedBannerAgendas(tab, settings) : await bannerAgendas(tab) : [];
    const state = await getState();
    const entry = (await getArmed())[tabId];
    const agendaRoute = tab ? await routeAgendaTab(tab, settings, state, cachedOnly || !enabled || !settings.agendaBanner ? await cachedBannerAgendas(tab, settings) : agendas) : false;
    if (!isCurrent()) return;
    const ownRecording = state.tabId === tabId &&
        (!state.meetingTarget || sameMeetingTarget(state.meetingTarget, tab?.url));
    if (enabled && ownRecording && state.state !== STATE.idle && !(state.startConnectionError && !disconnected)) {
        if (state.sessionId || (state.state === STATE.error && !state.startConnectionError)) {
            await updateArmedTab(tabId, (current) => current ? {
                ...current, bannerPrompt: false, promptVisible: false, nudged: true, dismissed: true,
            } : null);
        }
        const recording = isLiveCapture(state);
        const view = recording ? "recording" : state.state === STATE.error ? "error" :
            state.state === STATE.awaitingPicker ? "waiting" : "stopped";
        if (view === "error" && (entry?.errorDismissed || state.meetingBannerErrorDismissed)) {
            await sendMeetingBanner(tabId, { view: "hidden" });
        } else await sendMeetingBanner(tabId, { view,
            connection: connectionNotice(connection, { recording, starting: state.startConnectionError || state.connecting }),
            state: {
            state: state.state,
            sessionId: state.sessionId,
            startedAt: state.startedAt,
            stopped: state.stopped,
            connecting: state.connecting,
            uploadNotice: state.uploadNotice,
            folderId: state.folderId,
            folderLabel: state.folderLabel,
            folderScope: state.folderScope ?? null,
            recordingFolderOverride: state.recordingFolderOverride === true && settings.serverDefaults?.recordingFolderOverride === true,
            error: state.error,
            agendas: supportsAgendas(settings) && settings.agendaBanner
                ? (state.agendaId ? [{ id: state.agendaId, title: state.agendaTitle }] : agendas) : [],
        } });
        await safe(chrome.action.setPopup({ tabId, popup: agendaTabs.has(tabId) || entry?.mode === "auto" ? "" : POPUP_URL }));
        return;
    }
    if (enabled && entry?.bannerError && !entry.errorDismissed &&
        sameMeetingTarget(entry.meetingTarget, tab.url)) {
        await sendMeetingBanner(tabId, { view: "error", state: { error: entry.bannerError } });
        await safe(chrome.action.setPopup({ tabId, popup: agendaTabs.has(tabId) || entry.mode === "auto" ? "" : POPUP_URL }));
        return;
    }
    if (enabled && settings.nudgeEnabled && entry?.bannerPrompt &&
        sameMeetingTarget(entry.meetingTarget, tab.url)) {
        const pinAtLookup = pinGeneration;
        const isCurrentPrompt = () => isCurrent() && pinAtLookup === pinGeneration;
        const [commands, actionSettings] = await Promise.all([
            chrome.commands.getAll().catch(() => []),
            chrome.action.getUserSettings().catch(() => ({})),
        ]);
        if (!isCurrentPrompt()) return;
        const pinned = actionSettings.isOnToolbar !== false;
        if (!pinned) void promptIcon.stop(tabId);
        const blink = pinned ? await promptIcon.reserve(tabId, isCurrentPrompt) : null;
        if (!isCurrentPrompt()) return;
        const response = await sendMeetingBanner(tabId, {
            view: "prompt",
            connection: connectionNotice(connection),
            agendas,
            agendaPanel: agendaRoute,
            notice: effectiveNoticeText(settings),
            shortcut: commands.find((command) => command.name === "toggle-recording")?.shortcut || "",
            pinned,
            blinkUntil: blink?.until ?? null,
            policyRequired: entry.mode === "auto" && !settings.autoModeAcknowledgedAt,
        }, isCurrentPrompt);
        if (!isCurrentPrompt()) return;
        const next = await updateArmedTab(tabId, (current) => current && isCurrentPrompt() ? {
            ...current,
            promptVisible: current.bannerPrompt === true && response?.visible === true,
            shownAgendaId: response?.visible === true && agendas.length === 1 ? agendas[0].id : undefined,
            notificationFallback: response?.visible === true ? false : current.notificationFallback,
        } : current);
        if (!isCurrentPrompt()) return;
        await applyArmedUi(tabId, platformById(entry.platformId), entry.mode, next?.promptVisible);
        if (!isCurrentPrompt()) return;
        if (next?.promptVisible) promptIcon.start(tabId, blink);
        else stopPromptIcon(tabId);
        if (next?.promptVisible) {
            if (disconnected) void ensureConnectionAlarm().catch(() => {});
            await chrome.notifications.clear(`${NUDGE_PREFIX}${tabId}`).catch(() => {});
        } else if (next?.bannerPrompt && !next.notificationFallback) {
            await notifyMeetingNudge(tabId, platformById(entry.platformId), settings);
        }
        return;
    }
    await sendMeetingBanner(tabId, { view: "hidden" });
    if (entry?.promptVisible || entry?.bannerPrompt) {
        await updateArmedTab(tabId, (current) => current ? { ...current, promptVisible: false, bannerPrompt: false } : null);
        await safe(chrome.action.setPopup({ tabId, popup: agendaTabs.has(tabId) || entry.mode === "auto" ? "" : POPUP_URL }));
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
        return stopRecording("user", { tabId, sessionId: message.sessionId });
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
        const auth = { serverUrl: settings.serverUrl, connectionId: settings.connectionId, apiKey: await readToken() };
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
    if (message.type === "meeting-banner-dismiss") await dismissMeetingBanner(tabId);
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
        await safe(chrome.action.setPopup({ tabId, popup: agendaTabs.has(tabId) || armed[id].mode === "auto" ? "" : POPUP_URL }));
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
            popup: agendaTabs.has(tabId) || mode === "auto" || promptVisible ? "" : POPUP_URL,
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
    await safe(chrome.action.setPopup({ tabId, popup: agendaTabs.has(tabId) ? "" : POPUP_URL }));
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
    const nextMeeting = (await cachedNextMeeting())?.data;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (settings.meetingNotifications && nextMeeting && Date.parse(nextMeeting.end) > Date.now() &&
        meetingRoom(nextMeeting.joinUrl) === meetingRoom(tab?.url)) return;
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
    await routeAgendaTab(tab, settings, state);
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
    if (changeInfo.url || changeInfo.status === "loading") stopPromptIcon(tabId, true);
    if (changeInfo.url || changeInfo.status === "complete") {
        void updateNextMeetingBadge().catch(() => {});
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
    stopPromptIcon(tabId);
    const cleared = clearJoinedMeeting(tabId);
    await agendaRoutesLoaded;
    await cleared;
    agendaTabs.delete(tabId); openPanels.delete(tabId);
    await chrome.storage.session.remove([agendaPanelKey(tabId), `agenda-match:${tabId}`, `agenda-route:${tabId}`, `agenda-open:${tabId}`]);
    void updateNextMeetingBadge().catch(() => {});
    await sendMeetingBanner(tabId, { view: "hidden" });
    await disarm(tabId);
    await chrome.alarms.clear(`${ALARMS.quietPrefix}${tabId}`);
    const state = await getState();
    if (isLiveCapture(state) && state.tabId === tabId) {
        await stopRecording("tab-closed");
    }
});

chrome.action.onUserSettingsChanged?.addListener((changes) => {
    if (typeof changes.isOnToolbar !== "boolean") return;
    pinGeneration++;
    const pending = new Set(bannerSyncs.keys());
    void getArmed().then((armed) => Promise.all(Object.entries(armed)
        .filter(([tabId, entry]) => entry.promptVisible || (entry.bannerPrompt && pending.has(Number(tabId))))
        .map(([tabId]) => syncMeetingBanner(Number(tabId), true)))).catch(() => {});
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
    if (changes.meetingNotifications || changes.meetingLeadMinutes) void Promise.all([cachedNextMeeting().then((cached) => scheduleNextMeeting(cached?.data)), scheduleAgendaReminders()]).catch(() => {});
    if (changes.agendaReminders) void (changes.agendaReminders.newValue === false
        ? clearAgendaReminders() : refreshAgendas()).catch(() => {});
    if (changes.agendaBanner) void reevaluateAllTabs();
    if (changes.encryptedApiKey || changes.serverUrl || changes.serverDefaults || changes.dataUseAcknowledgedAt) {
        void getSettings().then(async (settings) => {
            if (!supportsAgendas(settings)) {
                await reconcileJoinedMeetings();
                await clearAgendas();
            }
            if (settings.serverDefaults?.nextMeeting !== true) await clearNextMeeting();
            else await refreshNextMeeting();
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
    if ((state.state === STATE.recording || isLiveCapture(state)) && !state.stopped && state.tabId === tab.id) {
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
    if (!agendaRoutesReady) {
        let opened;
        try {
            const enabled = chrome.sidePanel.setOptions({ tabId: tab.id, path: `agenda/agenda.html?tab=${tab.id}`, enabled: true });
            opened = Promise.all([enabled, chrome.sidePanel.open({ tabId: tab.id })]).then(() => true, () => false);
        } catch { opened = Promise.resolve(false); }
        void agendaRoutesLoaded.then(async (loaded) => {
            const shown = await opened;
            if (!loaded) { if (shown) await closeAgendaPanel(tab.id); return; }
            const restored = agendaTabs.get(tab.id);
            if (restored) {
                if (loaded[`agenda-open:${tab.id}`] === true) await closeAgendaPanel(tab.id);
                else if (shown) {
                    await setAgendaPanelOpen(tab.id, true);
                    await chrome.storage.session.set({ [agendaPanelKey(tab.id)]: restored });
                }
                else {
                    const key = await openAgendaPanel({ tabId: tab.id }, restored.agendaIds);
                    await chrome.storage.session.set({ [key]: restored });
                }
            } else {
                await closeAgendaPanel(tab.id).catch(() => {});
                await startFromInvocation(tab);
            }
        }).catch(() => {});
        return;
    }
    const route = agendaTabs.get(tab.id);
    if (route) {
        if (openPanels.has(tab.id)) { void closeAgendaPanel(tab.id).catch(() => {}); return; }
        const opened = openAgendaPanel({ tabId: tab.id }, route.agendaIds);
        void opened.then((key) => chrome.storage.session.set({ [key]: route })).catch(() => {});
        return;
    }
    void startFromInvocation(tab);
});

chrome.commands.onCommand.addListener(async (command) => {
    if (command !== "toggle-recording") return;
    const state = await getState();
    if (isLiveCapture(state)) {
        await stopRecording("user");
        return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await startFromInvocation(tab);
});

// ---- Alarms: auto-stop and config refresh --------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name.startsWith(MEETING_END_PREFIX)) { await clearJoinedMeeting(Number(alarm.name.slice(MEETING_END_PREFIX.length))); await reevaluateAllTabs(); return; }
    if (alarm.name === NEXT_REFRESH) { await refreshNextMeeting(); return; }
    if (alarm.name === NEXT_START) { await notifyNextMeeting(); await updateNextMeetingBadge(); return; }
    if (alarm.name === NEXT_BADGE) { await updateNextMeetingBadge(); return; }
    if (alarm.name === NEXT_END) { await updateNextMeetingBadge(); return; }
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
    if (alarm.name === CONNECTION_ALARM) {
        if (await needsConnectionProbe() && await connectionHasWaiters()) await probeConnection().catch(() => {});
        else await chrome.alarms.clear(CONNECTION_ALARM);
        return;
    }
    if (alarm.name === ALARMS.uploadRetry) {
        if (await serverUnavailable()) await ensureConnectionAlarm();
        else await resumeUploadWork();
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
        if (!(await stopRecording("auto-quiet")).ok) return;
        await notify(
            t("recordingStopped"),
            t("recordingStoppedBody"),
        );
    }
});

async function ensureConfigAlarm() {
    await chrome.alarms.create(NEXT_REFRESH, { periodInMinutes: 5 });
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

function isExtensionPage(url, path) {
    try {
        const actual = new URL(url);
        const expected = new URL(chrome.runtime.getURL(path));
        // Compare protocol and host because extension URL origins can serialize as "null".
        return actual.protocol === expected.protocol && actual.host === expected.host &&
            actual.pathname === expected.pathname;
    } catch {
        return false;
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target === "offscreen") return false;
    if (message.type === "join-meeting") {
        if (sender.id !== chrome.runtime.id || ![POPUP_URL, "agenda/agenda.html"].some((path) => sender.url?.split("?")[0] === chrome.runtime.getURL(path))) {
            sendResponse({ ok: false, error: t("unrecognizedSender") }); return false;
        }
        (async () => {
            const cached = await cachedNextMeeting();
            const meeting = cached?.data;
            if (meeting?.eventId !== message.eventId || !Number.isInteger(message.tabId)) throw new Error(t("agendaFailed"));
            const tab = await publishJoinedMeeting({ ...meeting, serverUrl: cached.serverUrl, connectionId: cached.connectionId }, message.tabId, publishJoinRoute);
            if (message.fallback === true && meeting.agendaId) {
                await chrome.tabs.update(tab.id, { active: true });
                const key = await openAgendaWindow({ tabId: tab.id }, [meeting.agendaId]);
                await chrome.storage.session.set({ [key]: agendaTabs.get(tab.id) });
            }
            return tab;
        })()
            .then((tab) => sendResponse({ ok: true, tabId: tab.id }))
            .catch(() => sendResponse({ ok: false, error: t("agendaFailed") }));
        return true;
    }
    if (message.type === "open-agenda") {
        const extensionPage = sender.id === chrome.runtime.id &&
            [POPUP_URL, "agenda/agenda.html"].some((path) => sender.url?.split("?")[0] === chrome.runtime.getURL(path));
        const meeting = sender.id === chrome.runtime.id && sender.frameId === 0 &&
            Number.isInteger(sender.tab?.id) && isPromptMeeting(sender.url);
        if (!extensionPage && !meeting) { sendResponse({ ok: false, error: t("unrecognizedSender") }); return false; }
        const opened = openAgendaPanel({ tabId: meeting ? sender.tab.id : message.tabId, matchTabId: meeting ? sender.tab.id : message.matchTabId, windowId: message.windowId }, []);
        Promise.all([opened, resolvePanelAgenda(message, sender, meeting, opened)]).then(() => sendResponse({ ok: true }))
            .catch(async () => {
                const key = await opened.catch(() => null);
                if (key) {
                    const stored = (await chrome.storage.session.get(key))[key] ?? {};
                    await chrome.storage.session.set({ [key]: { ...stored, tabId: meeting ? sender.tab.id : message.matchTabId ?? message.tabId, error: true } });
                }
                sendResponse({ ok: false, error: t("agendaFailed") });
            });
        return true;
    }

    if (["recorder-connection-watch", "recorder-connection-retry", "recorder-connection-outcome"].includes(message.type)) {
        const page = sender.id === chrome.runtime.id && CONNECTION_PAGES.some((path) => isExtensionPage(sender.url, path));
        const banner = message.type === "recorder-connection-retry" && !page;
        (async () => {
            if (!page && !(banner && await validMeetingBannerSender(sender))) return { ok: false };
            if (message.type === "recorder-connection-outcome") await queueConnectionOutcome(message.outcome);
            else if (message.type === "recorder-connection-watch") await ensureConnectionAlarm();
            else if (!(await probeConnection())) return { ok: false, error: t("connectFirst") };
            return { ok: true };
        })().then(sendResponse, (error) => sendResponse({
            ok: false,
            error: error?.message ?? t("recoveryUnavailable"),
        }));
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
        case "room-presence":
        case "room-agendas":
        case "edit-agenda":
            handleAgendaMessage(message, sender).then(sendResponse)
                .catch(error => sendResponse({
                    ok: false,
                    error: t("agendaFailed"),
                    ...(message.edit ? { kind: error?.kind, status: error?.status } : {}),
                }));
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
                    sendResponse({ ok: false, ...(isConnectionError(error) ? { connection: true } : {}), error: error?.message ?? String(error) }),
                );
            return true;

        case "next-meeting-opened":
            refreshNextMeeting({ opened: true }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
            return true;
        case "close-agenda":
            closeAgendaPanel(message.tabId).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
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
                        connectionId: settings.connectionId,
                        apiKey: await readToken(),
                    };
                    if (typeof message.id === "string")
                        return getRecorderFolder(auth, message.id);
                    if (typeof message.q === "string")
                        return searchRecorderFolders(auth, message.q);
                    return listRecorderFolders(auth);
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
            if (![POPUP_URL, "agenda/agenda.html"].some((path) => sender.url?.split("?")[0] === chrome.runtime.getURL(path))) {
                sendResponse({ ok: false, error: t("unrecognizedSender") });
                return false;
            }
            startRecording({ ...message.payload, fromPopup: true, auto: false })
                .then((result) => sendResponse({ ok: true, ...result }))
                .catch((error) =>
                    sendResponse({ ok: false, ...(isConnectionError(error) ? { connection: true } : {}), error: error?.message ?? String(error) }),
                );
            return true;

        case "stop-recording":
            stopRecording(message.reason ?? "user")
                .then(sendResponse)
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
                    if (await serverUnavailable()) return;
                    if (await healStoppedUpload()) return;
                    if (!state.sessionId || !isPollingFinalization(state)) {
                        return;
                    }
                    const settings = await getSettings();
                    await pollFinalization(state, {
                        serverUrl: settings.serverUrl,
                        connectionId: settings.connectionId,
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
            getState().then(async (state) => {
                if (state.sessionId !== message.sessionId) throw new Error(t("recoveryUnavailable"));
                if (message.sessionId) await discardBuffer(state.bufferId ?? state.sessionId);
                else await resetState();
            })
                .then(() => sendResponse({ ok: true }))
                .catch((error) =>
                    sendResponse({ ok: false, error: error?.message ?? String(error) }),
                );
            return true;

        case "retry-buffer":
        case "discard-buffer":
            if (sender.id !== chrome.runtime.id || !isExtensionPage(sender.url, "options/options.html") ||
                typeof message.bufferId !== "string" || !/^[\w-]+$/.test(message.bufferId)) {
                sendResponse({ ok: false, error: t("unrecognizedSender") });
                return false;
            }
            (message.type === "retry-buffer" ? retryBuffer(message.bufferId) : discardBuffer(message.bufferId))
                .then(() => sendResponse({ ok: true }))
                .catch((error) =>
                    sendResponse({ ok: false, ...(isConnectionError(error) ? { connection: true } : {}), error: retryErrorMessage(error) }),
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
        await setState({ stopped: true, chunkCount: message.chunkCount ?? 0 });
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
    const latest = await getState();
    await setState({
        stopped: true,
        chunkCount: message.chunkCount,
        ...(latest.blocked ? { state: STATE.error, error: latest.error ?? latest.uploadNotice, uploadNotice: null } : {}),
        recoverablePrefix: latest.recoverablePrefix ?? (firstMissing && firstMissing > 0 ? firstMissing : null),
    });
    if (state.captureMode === "desktop" && state.captureWindowId != null) {
        await chrome.windows.update(state.captureWindowId, {
            state: "normal",
            focused: true,
        }).catch(() => {});
    }
    await pumpUploads();
}

function savePlayablePrefix(chunkCount) {
    return transitionBuffer(() => savePlayablePrefixOnce(chunkCount));
}

async function savePlayablePrefixOnce(chunkCount) {
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
    await updateLocalMeta(state.bufferId ?? state.sessionId, { truncatedAtChunk: chunkCount });
    await setState({ blocked: false, truncatedAtChunk: chunkCount });
    await finalize(chunkCount);
}

function retryUpload() {
    return transitionBuffer(retryUploadOnce);
}

async function retryUploadOnce() {
    const state = await getState();
    if (!state.sessionId) return;
    if (isLiveCapture(state)) throw new Error(t("retryBufferCaptureLive"));
    const settings = await getSettings();
    const auth = { serverUrl: settings.serverUrl, connectionId: settings.connectionId, apiKey: await readToken() };
    let remote = await getSession(auth, state.sessionId);
    if (!sameUploadOwner(await getState(), state)) throw new Error(t("retryBufferBusy"));
    if (remote.status === "completed" || remote.status === "completing") {
        await setState({
            state: STATE.finalizing,
            jobId: remote.job_id ?? null,
            serverCompleting: true,
            finalizingAt: new Date().toISOString(),
            error: null,
            uploadNotice: null,
            blocked: false,
        });
        await pollFinalization(state, auth);
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
    if (!sameUploadOwner(await getState(), state)) throw new Error(t("retryBufferBusy"));
    await setState({
        bufferId: state.bufferId ?? state.sessionId,
        sessionId: remote.id ?? state.sessionId,
        uploaded: remote.received_chunks ?? [],
        blocked: false,
        reconcilePending: false,
        recoverablePrefix: null,
        state: STATE.error,
        jobId: null,
        serverCompleting: false,
        error: null,
        uploadNotice: null,
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

function retryErrorMessage(error, fallback = t("recoveryUnavailable")) {
    if (error?.code === "ACCESS_UNVERIFIABLE") return t("accessUnverifiable");
    if (error?.status === 404) return t("recordingKeyExpired");
    return accessErrorMessage(error) ?? error?.message ?? fallback;
}

let bufferTransitions = Promise.resolve();
let bufferTransitionCount = 0;

function transitionBuffer(change) {
    if (starting) return Promise.reject(new Error(t("retryBufferCaptureLive")));
    bufferTransitionCount++;
    const work = bufferTransitions.catch(() => {}).then(async () => {
        if (uploadPump) await uploadPump;
        if (finalization) await finalization;
        const state = await getState();
        const reconciliation = pendingReconciliations.get(state.sessionId);
        if (reconciliation) await reconciliation;
        return change();
    }).finally(() => {
        bufferTransitionCount--;
        if (!bufferTransitionCount && pumpRequested) void pumpUploads();
    });
    bufferTransitions = work;
    return work.then(async (result) => {
        if (!bufferTransitionCount && uploadPump) await uploadPump;
        return result;
    });
}

async function assertBufferRetryAllowed(bufferId) {
    const state = await getState();
    if (starting || state.state === STATE.awaitingPicker || isLiveCapture(state)) {
        throw new Error(t("retryBufferCaptureLive"));
    }
    if ((state.bufferId ?? state.sessionId) !== bufferId && state.sessionId &&
        ([STATE.recording, STATE.finalizing].includes(state.state) || uploadPump || finalization)) {
        throw new Error(t("retryBufferBusy"));
    }
    return state;
}

async function retryBuffer(bufferId) {
    await transitionBuffer(() => retryBufferOnce(bufferId));
    const latest = await getState();
    if ((latest.bufferId ?? latest.sessionId) === bufferId && (latest.error || latest.uploadNotice)) {
        throw new Error(latest.error || latest.uploadNotice);
    }
}

async function retryBufferOnce(bufferId) {
    await assertBufferRetryAllowed(bufferId);
    const meta = await readLocalMeta(bufferId);
    if (!meta) throw new Error(t("recoveryUnavailable"));
    const settings = await getSettings();
    if (!settings.dataUseAcknowledgedAt) throw new Error(t("dataUseRequired"));
    if (meta.serverUrl !== settings.serverUrl || !settings.hasApiKey) throw new Error(t("connectFirst"));
    const state = await assertBufferRetryAllowed(bufferId);
    if ((state.bufferId ?? state.sessionId) === bufferId) {
        if (state.state === STATE.completed || state.state === STATE.idle) return;
        await retryUploadOnce();
        await healStoppedUpload();
    } else {
        const auth = { serverUrl: settings.serverUrl, connectionId: settings.connectionId, apiKey: await readToken() };
        let remote = await getSession(auth, meta.serverSessionId ?? bufferId);
        await assertBufferRetryAllowed(bufferId);
        if (remote.status === "aborted" || remote.status === "failed") {
            remote = await recoverSession(auth, meta.serverSessionId ?? bufferId);
            await updateLocalMeta(bufferId, { serverSessionId: remote.id });
        }
        await assertBufferRetryAllowed(bufferId);
        const serverSessionId = remote.id ?? meta.serverSessionId ?? bufferId;
        if (remote.status === "completed" || remote.status === "completing") {
            await setState({
                ...IDLE_STATE,
                ...recordingFolderState(meta),
                state: STATE.finalizing,
                reconcilePending: false,
                stopped: true,
                sessionId: serverSessionId,
                bufferId,
                jobId: remote.job_id ?? null,
                serverCompleting: true,
                finalizingAt: new Date().toISOString(),
            });
            await pollFinalization(await getState(), auth);
        } else if (remote.status === "open") {
            if (!(await resumeBufferedSession(bufferId, meta, remote, true))) {
                throw new Error(t("recoveryUnavailable"));
            }
        } else {
            throw new Error(t("recoveryUnavailable"));
        }
    }
}

async function discardSession(sessionId) {
    const settings = await getSettings();
    const state = await getState();
    if (sessionId && settings.serverUrl && settings.hasApiKey && !(await serverUnavailable(settings))) {
        await abortSession(
            { serverUrl: settings.serverUrl, connectionId: settings.connectionId, apiKey: await readToken() },
            sessionId,
        ).catch(() => {});
    }
    if (sessionId) await safe(deleteLocalSession(state.bufferId ?? sessionId));
    await resetState();
}

function discardBuffer(bufferId) {
    return transitionBuffer(() => discardBufferOnce(bufferId));
}

async function discardBufferOnce(bufferId) {
    const state = await getState();
    if ((state.bufferId ?? state.sessionId) === bufferId && isLiveCapture(state)) {
        throw new Error("Stop recording before discarding its buffer");
    }
    const meta = await readLocalMeta(bufferId);
    const settings = await getSettings();
    if (meta && meta.serverUrl === settings.serverUrl && settings.hasApiKey) {
        const auth = { serverUrl: settings.serverUrl, connectionId: settings.connectionId, apiKey: await readToken() };
        try {
            const remote = await getSession(auth, meta.serverSessionId ?? bufferId);
            if (remote.status === "completing") {
                throw new Error("Wait for server finalization before discarding");
            }
            if (remote.status === "completed" && remote.recording_id === null) {
                throw new Error(t("recoveryUnavailable"));
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
    metaUpdates = metaUpdates.catch(() => {}).then(() => deleteLocalSession(bufferId));
    await metaUpdates;
    const latest = await getState();
    if ((latest.bufferId ?? latest.sessionId) === bufferId) await resetState();
}

// ---- Startup ---------------------------------------------------------------

function recordingFolderState(meta) {
    return {
        agendaId: meta?.agendaId ?? null,
        agendaTitle: meta?.agendaTitle ?? null,
        agendaOwn: meta?.agendaOwn === true,
        agendaExplicit: meta?.agendaExplicit === true,
        agendaUnavailable: meta?.agendaUnavailable === true,
        folderId: meta?.folderId ?? null,
        folderLabel: meta?.folderLabel ?? null,
        folderScope: meta?.folderScope ?? null,
        startFolderScope: meta?.startFolderScope ?? null,
        startFolderId: meta?.startFolderId ?? null,
        startFolderLabel: meta?.startFolderLabel ?? null,
        recordingFolderOverride: meta?.recordingFolderOverride === true,
        truncatedAtChunk: meta?.truncatedAtChunk ?? null,
    };
}

async function resumeBufferedSession(bufferId, meta, session, resetRetry = false) {
    const stored = await listChunkIndices(bufferId);
    if (stored.length === 0) return false;
    if (resetRetry) {
        await updateLocalMeta(bufferId, { retryAttempt: 0, nextRetryAt: null });
        await assertBufferRetryAllowed(bufferId);
    }
    await setState({
        ...IDLE_STATE,
        ...recordingFolderState(meta),
        state: STATE.recording,
        sessionId: session.id ?? meta.serverSessionId ?? bufferId,
        bufferId,
        startedAt: meta.startedAt ?? null,
        platformHint: meta.platformHint ?? null,
        chunkCount: Math.max(...stored) + 1,
        stopped: true,
        stopReason: "browser-closed",
        uploaded: session.received_chunks ?? [],
        captureMode: null,
        captureWindowId: null,
        pickerRequestId: null,
    });
    await pumpUploads();
    return true;
}

function reconcileOnStartup() {
    startupReconciliation ??= reconcileStartup().finally(() => { startupReconciliation = null; });
    return startupReconciliation;
}

async function reconcileStartup() {
    await joinedMeetingsLoaded;
    await unregisterPairingScripts();
    await reconcileMeetingPrompt().catch((error) =>
        console.warn("[recorder] meeting prompt registration:", error),
    );
    await ensureConfigAlarm();
    void refreshServerConfig().catch(() => {});
    await reconcileDesktopWindow();
    // Session storage is empty after a browser restart; re-arm open meetings.
    await reevaluateAllTabs();
    await reconcileBufferedRecordings();
}

async function markBufferedReconciliation(bufferId, meta, sessionId, error) {
    if (!(await readLocalMeta(bufferId))) return false;
    const outage = isConnectionError(error);
    const waiting = outage || [429, 500, 502, 503, 504].includes(error?.status);
    await setState({
        ...IDLE_STATE,
        ...recordingFolderState(meta),
        state: waiting ? STATE.recording : STATE.error,
        sessionId,
        bufferId,
        startedAt: meta.startedAt,
        chunkCount: waiting ? Math.max(-1, ...await listChunkIndices(bufferId)) + 1 : 0,
        stopped: true,
        blocked: !waiting,
        reconcilePending: waiting,
        error: waiting ? null : retryErrorMessage(error),
        uploadNotice: waiting && !outage ? retryErrorMessage(error) : null,
    });
    if (outage) await ensureConnectionAlarm();
    else if (waiting) await scheduleUploadRetry(bufferId, error);
    return waiting;
}

let bufferReconciliation;
function reconcileBufferedRecordings() {
    bufferReconciliation ??= transitionBuffer(reconcileBufferedRecordingsOnce).finally(() => { bufferReconciliation = null; });
    return bufferReconciliation;
}

async function reconcileBufferedRecordingsOnce() {
    const settings = await getSettings();
    if (!settings.dataUseAcknowledgedAt || !settings.serverUrl || !settings.hasApiKey) return;
    let token;
    try {
        token = await readToken();
    } catch (error) {
        const [bufferId] = await listLocalSessions();
        const meta = bufferId ? await readLocalMeta(bufferId) : null;
        if (meta) {
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
    const auth = { serverUrl: settings.serverUrl, connectionId: settings.connectionId, apiKey: token };

    const state = await getState();
    if (state.state === STATE.recording && state.stopped && !state.reconcilePending) {
        await pumpUploads();
        return;
    }
    if (isLiveCapture(state) && state.captureMode === "desktop") {
        pumpUploads();
        return;
    }
    if (isLiveCapture(state) && (await hasOffscreen())) {
        pumpUploads();
        return;
    }
    if (state.state === STATE.finalizing && state.sessionId) {
        if (await healStoppedUpload()) return;
        await pollFinalization(state, auth);
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
            if (await markBufferedReconciliation(sessionId, meta, serverSessionId, error)) break;
            continue;
        }
        if (!(await readLocalMeta(sessionId))) continue;
        if (session.status === "completed") {
            await setState({ ...recordingFolderState(meta), sessionId: serverSessionId, bufferId: sessionId, reconcilePending: false });
            await reconcileServerSession(serverSessionId, auth).catch((error) =>
                markBufferedReconciliation(sessionId, meta, serverSessionId, error));
            if ((await getState()).reconcilePending) break;
            continue;
        }
        if (session.status === "completing") {
            await setState({
                ...recordingFolderState(meta),
                state: STATE.finalizing,
                reconcilePending: false,
                stopped: true,
                sessionId: serverSessionId,
                bufferId: sessionId,
                jobId: session.job_id,
                serverCompleting: true,
                finalizingAt: new Date().toISOString(),
            });
            await ensureUploadRetryAlarm();
            break;
        }
        if (session.status === "aborted" || session.status === "failed") {
            try {
                session = await recoverSession(auth, serverSessionId);
                if (!(await readLocalMeta(sessionId))) continue;
                serverSessionId = session.id;
                await updateLocalMeta(sessionId, {
                    serverSessionId,
                });
            } catch (error) {
                if (await markBufferedReconciliation(sessionId, meta, serverSessionId, error)) break;
                continue;
            }
        }
        if (session.status !== "open") continue;
        // Only resume into a recording state when nothing else is active.
        const live = await getState();
        if (live.state !== STATE.idle && live.state !== STATE.error && !live.reconcilePending) break;
        if (!(await resumeBufferedSession(sessionId, meta, session, state.reconcilePending === true))) {
            if (live.reconcilePending && live.bufferId === sessionId) await resetState();
            continue;
        }
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

void ensureConnectionAlarm().catch(() => {});
void getState().then(async (state) => {
    if (state.sessionId && isPollingFinalization(state)) {
        await ensureUploadRetryAlarm();
    } else if (state.reconcilePending) {
        await resumeUploadWork();
    } else {
        await healStoppedUpload();
    }
}).catch(() => {});
