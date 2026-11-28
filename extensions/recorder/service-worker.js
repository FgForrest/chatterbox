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
    createSealedSession,
    getSession,
    getRecorderFolder,
    recoverSession,
    searchRecorderFolders,
    sha256Hex,
    uploadChunk,
    listRecorderFolders,
    listRecordingSessions,
    setSessionAgenda,
} from "./lib/api.js";
import {
    listChunkIndices,
    readChunk,
    readLocalMeta,
    totalBufferedBytes,
    writeCaptureStop,
} from "./lib/chunk-store.js";
import {
    attachSession,
    captureAgendaTitleKey,
    captureHasGap,
    confirmCaptureChunk,
    createCapture,
    deleteCapture,
    listPendingCaptures,
    markStopped,
    onCaptureChunk,
    resolveCaptureCleanup,
    retainCaptureCleanup,
    serverSessionFor,
    sessionForIntent,
    updateCapture,
    verifiedPrefix,
    withCapture,
    withPairingBinding,
} from "./lib/capture-state.js";
import { lowCaptureStorage } from "./lib/capture-storage.js";
import { recordingStartPath, sealedRecipient, sealedRefusalMessage, validSessionLimit } from "./lib/sealed-recording.js";
import { createCaptureLeases } from "./lib/capture-lease.js";
import {
    ALARMS,
    CHANNEL_LAYOUT_MIXED,
    CHANNEL_LAYOUT_SPLIT,
    MESSAGES,
    SESSION_MIME_TYPE,
    STORAGE_KEYS,
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
import { createRoomRecorderLookup, roomPairingChanged } from "./lib/room-recorders.js";
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
const ARMED_BADGE = { text: "REC?", color: "#d33" };
const RECORDING_BADGE = { text: "REC", color: "#d33" };
const EMPTY_BADGE = { text: "" };
const MIC_BADGE = { text: "MIC!", color: "#b45309" };
const tabBadgeUpdates = new Map();
const promptIcon = createPromptIconBlink(agendaRoutesLoaded, clearPromptBlinkCopy, {
    paintBadge: (tabId, highlighted, isCurrent) => queueTabBadge(tabId, () => highlighted ? EMPTY_BADGE : ARMED_BADGE, isCurrent),
    restoreBadge: restorePromptBadge,
});
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
    return Boolean((captureIdOf(state) && state.state !== STATE.completed) ||
        Object.values(armed).some((entry) => entry.bannerPrompt || entry.promptVisible || entry.bannerError) ||
        contexts.some(({ documentUrl }) => CONNECTION_PAGES.some((path) => isExtensionPage(documentUrl, path))) ||
        await hasPendingCaptureForPairing());
}

async function hasPendingCaptureForPairing() {
    const settings = await getSettings();
    return (await listPendingCaptures({ includeCleanup: true })).some(({ meta }) => meta && capturePairingMatches(meta, settings));
}

async function needsConnectionProbe() {
    const settings = await getSettings();
    const connection = await readServerConnection(settings);
    if (settings.serverDefaults?.sealedProbeNeeded === true ||
        (connection && (connection.state !== "ok" || connection.configError))) return true;
    return settings.hasApiKey && settings.serverDefaults?.offlineRecipient && settings.serverDefaults.offlineRecording !== true &&
        (await listPendingCaptures({ includeCleanup: true })).some(({ meta }) => meta?.protocol === 2 &&
            (meta.cleanupPending || (!meta.serverSessionId && !meta.blocked)) && capturePairingMatches(meta, settings));
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
    if (!(await needsConnectionProbe())) await chrome.alarms.clear(CONNECTION_ALARM);
    const state = await getState();
    const upload = async () => {
        if (captureIdOf(state) && state.state !== STATE.completed) {
            const captureId = captureIdOf(state);
            await withCapture(captureId, async () => {
                const current = await getState();
                if (!sameUploadAttempt(current, state) || !(await readLocalMeta(captureId))) return;
                await updateLocalMeta(captureId, { retryAttempt: 0, nextRetryAt: null });
                await setUploadState(null, {
                    uploadNotice: current.blocked && !current.stopped ? current.uploadNotice : null,
                    ...(current.sessionId && !current.blocked && !isPollingFinalization(current) && current.captureId
                        ? { reconcilePending: true } : {}),
                }, state);
            });
        }
        await reconcileBufferedRecordings();
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
    captureId: null,
    protocol: 1,
    bufferedBytes: 0,
    storedParts: 0,
    localStorageWarning: false,
    bufferedOffline: false,
    bufferId: null,
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
    captureStopping: false,
    captureMode: null,
    captureWindowId: null,
    pickerRequestId: null,
    startPath: null,
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
    finalizationAttempt: null,
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

function captureIdOf(state) {
    return state?.captureId ?? state?.bufferId ?? state?.sessionId ?? null;
}

function sameCapture(current, expected) {
    return captureIdOf(current) === captureIdOf(expected);
}

function messageMatchesCapture(state, message) {
    return message.captureId ? message.captureId === captureIdOf(state) :
        !state.captureId && Boolean(message.sessionId) && message.sessionId === state.sessionId;
}

function controlMatchesCapture(state, message) {
    return message.captureId ? message.captureId === captureIdOf(state) : state.sessionId === message.sessionId;
}

let stateUpdates = Promise.resolve();
const captureDiscards = new Map();

function setState(patch, owner, matches = sameCapture, canWrite) {
    const update = stateUpdates.catch(() => {}).then(() => writeState(patch, owner, matches, canWrite));
    stateUpdates = update;
    return update;
}

async function writeState(patch, owner, matches, canWrite) {
    const current = await getState();
    if (canWrite && !(await canWrite())) return;
    if (owner && !matches(current, owner)) return;
    if (typeof patch === "function") patch = patch(current);
    const next = { ...current, ...patch };
    const title = patch.agendaTitle && next.agendaId && captureIdOf(next)
        ? { [captureAgendaTitleKey(captureIdOf(next))]: { agendaId: next.agendaId, title: patch.agendaTitle } }
        : {};
    if (patch.agendaTitle === null && owner && next.agendaId === null && captureIdOf(next)) {
        await chrome.storage.session.remove(captureAgendaTitleKey(captureIdOf(next)));
    }
    await chrome.storage.session.set({ [STATE_KEY]: next, ...title });
    if (current.tabId != null && (current.tabId !== next.tabId || !sameUploadOwner(current, next) ||
        (canStreamMeetingLevels(current) && !canStreamMeetingLevels(next)))) {
        disconnectMeetingLevels(current.tabId);
    }
    chrome.runtime.sendMessage({ type: "state", state: next }).catch(() => {});
    await updateRecordingBadge(next);
    if ("reconcilePending" in patch && patch.reconcilePending) void ensureConnectionAlarm().catch(() => {});
    if (["state", "tabId", "stopped"].some((key) => key in patch)) void updateNextMeetingBadge().catch(() => {});
    const bannerFields = [
        "state", "tabId", "startedAt", "stopped", "folderId", "folderLabel", "folderScope",
        "recordingFolderOverride", "error", "agendaId", "uploadNotice", "connecting", "captureStopping",
    ];
    if (Object.keys(patch).some((key) => bannerFields.includes(key))) {
        // State writes must bypass bannerUpdates so capture never waits for a queued agenda lookup.
        if (current.tabId != null && current.tabId !== next.tabId) await syncMeetingBannerNow(current.tabId, true);
        if (next.tabId != null) await syncMeetingBannerNow(next.tabId, true);
    }
    return next;
}

async function resetState(owner, matches = sameCapture, { cachedOnly = false } = {}) {
    const clear = stateUpdates.catch(() => {}).then(async () => {
        const previous = await getState();
        if (owner && !matches(previous, owner)) return null;
        await chrome.storage.session.remove(STATE_KEY);
        if (previous.tabId != null) disconnectMeetingLevels(previous.tabId);
        chrome.runtime.sendMessage({ type: "state", state: { ...IDLE_STATE } }).catch(() => {});
        return previous;
    });
    stateUpdates = clear;
    const previous = await clear;
    if (!previous) return;
    await updateNextMeetingBadge().catch(() => {});
    const { tabId } = previous;
    if (tabId != null) {
        const tabUnclaimed = async () => (await getState()).tabId !== tabId;
        if (cachedOnly) await syncMeetingBannerNow(tabId, true);
        else await syncMeetingBanner(tabId);
        await queueTabBadge(tabId, () => EMPTY_BADGE, tabUnclaimed);
        if (!(await tabUnclaimed())) return;
        await safe(chrome.action.setTitle({ tabId, title: DEFAULT_TITLE }));
        if (cachedOnly) void reevaluateTab(tabId).catch(() => {});
        else await reevaluateTab(tabId);
    }
}

async function updateRecordingBadge(state) {
    const { tabId } = state;
    if (tabId == null) return;
    if (hasRecordingBadge(state)) {
        const badge = queueTabBadge(tabId, () => RECORDING_BADGE);
        void promptIcon.stop(tabId, true);
        await badge;
        return;
    }
    await queueTabBadge(
        tabId,
        async () => (await getArmed())[tabId] ? ARMED_BADGE : EMPTY_BADGE,
        () => !promptIcon.isBlinking(tabId),
    );
}

function hasRecordingBadge(state) {
    return state?.state === STATE.recording || state?.state === STATE.finalizing;
}

function queueTabBadge(tabId, getBadge, isCurrent = () => true) {
    const update = (tabBadgeUpdates.get(tabId) ?? Promise.resolve()).then(async () => {
        if (!(await isCurrent())) return;
        const badge = await getBadge();
        if (!badge || !(await isCurrent())) return;
        await safe(chrome.action.setBadgeText({ tabId, text: badge.text }));
        if (badge.color && await isCurrent()) {
            await safe(chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color }));
        }
    }).catch(() => {});
    tabBadgeUpdates.set(tabId, update);
    return update.finally(() => {
        if (tabBadgeUpdates.get(tabId) === update) tabBadgeUpdates.delete(tabId);
    });
}

function restorePromptBadge(tabId, isCurrent) {
    return queueTabBadge(tabId, async () => {
        const [state, armed] = await Promise.all([getState(), getArmed()]);
        if (state.tabId === tabId && hasRecordingBadge(state)) return RECORDING_BADGE;
        if (armed[tabId]) return ARMED_BADGE;
    }, isCurrent);
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
    if (startCancelled) return { cancelled: true };
    await setState({
        state: STATE.awaitingPicker,
        captureMode: "desktop",
        pickerRequestId: requestId,
        startPath: input.startPath,
        captureWindowId: null,
        tabId: input.tabId ?? null,
        meetingTarget: input.target,
        platformHint: input.platformHint ?? null,
        autoStarted: input.auto ?? false,
        noticeAcknowledgedAt: input.noticeAcknowledgedAt ?? null,
        withoutMicrophone: input.withoutMicrophone ?? false,
        error: null,
    });
    if (startCancelled) {
        await resetState();
        return { cancelled: true };
    }
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
        if (!startCancelled) await setState({ captureWindowId: pickerWindow.id });
        if (startCancelled) {
            await chrome.windows.remove(pickerWindow.id).catch(() => {});
            return { cancelled: true };
        }
    } catch (error) {
        if (startCancelled) return { cancelled: true };
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
    if (!captureIdOf(state) && state.state === STATE.awaitingPicker) {
        await resetState();
    } else if (isLiveCapture(state)) {
        await queueCaptureStop(state, "stream-ended", true);
        void pumpUploads().catch(() => {});
    }
}

async function reconcileDesktopWindow() {
    const state = await getState();
    if (state.captureMode !== "desktop" || state.captureWindowId == null) return;
    if (state.state !== STATE.awaitingPicker && !isLiveCapture(state)) return;
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
let startCancelled = false;

async function requireStartTab(tabId, target) {
    if (tabId == null) return null;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error(t("meetingTabClosed"));
    if (target !== undefined && !sameMeetingTarget(target, tab.url)) throw new Error(t("recordingRequestExpired"));
    return tab;
}

/**
 * @param {{tabId?: number, platformHint?: string, auto?: boolean, noticeAcknowledgedAt?: string}} input
 */
async function startRecording(input, microphoneChecked = false, launchTab) {
    if (starting || bufferTransitionCount) throw new Error(t("alreadyInProgress"));
    starting = true;
    startCancelled = false;
    try {
        const settings = await getSettings();
        const startPath = input.startPath ?? recordingStartPath(settings);
        const tab = launchTab ?? await requireStartTab(input.tabId, input.meetingTarget);
        return await startRecordingLocked(input, microphoneChecked, meetingTarget(tab?.url), settings, startPath);
    } catch (error) {
        if ((await getState()).state === STATE.awaitingPicker) {
            await setState({
                state: STATE.error,
                error: error?.message ?? String(error),
            });
        }
        throw error;
    } finally {
        releaseStart();
    }
}

function releaseStart() {
    starting = false;
    void getState().then(async (state) => {
        if (state.protocol !== 2 || !captureIdOf(state)) return;
        if (isLiveCapture(state) && !state.sessionId) await bindForegroundSealed(state);
        await reconcileBufferedRecordings();
    }).catch(() => {});
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
    folderId,
    folderLabel,
    folderScope,
}, microphoneChecked, target, settings, startPath) {
    let current = await getState();
    if (current.stopped && current.protocol === 2 && captureIdOf(current)) {
        await setState(IDLE_STATE, current);
        current = await getState();
    }
    if (current.state !== STATE.idle && current.state !== STATE.error) {
        throw new Error(t("alreadyInProgress"));
    }
    if (captureIdOf(current)) throw new Error(t("unsentRecordingsBody"));
    if (!settings.serverUrl || !settings.hasApiKey || !sameConnection(startPath, settings)) {
        throw new Error(t("connectFirst"));
    }
    if (!settings.dataUseAcknowledgedAt) {
        throw new Error(t("dataUseRequired"));
    }
    if (tabId != null) {
        await updateArmedTab(tabId, (entry) => entry ? {
            ...entry, bannerError: null, errorDismissed: false,
        } : entry);
    }
    try {
        await prepareRecordingAgenda(tabId, fromPopup ? agendaId : undefined, Boolean(startPath.recipient));
    } catch (error) {
        if (!isConnectionError(error)) throw error;
    }
    const auth = await recorderAuth(settings);
    if (!microphoneChecked && (await microphonePermission()) !== "granted") {
        return openStartRequest({
            tabId,
            platformHint,
            auto,
            noticeAcknowledgedAt,
            fromPopup, agendaId, folderId, folderLabel, folderScope, startPath,
        }, await requireStartTab(tabId, target));
    }
    if (!noticeAcknowledgedAt) throw new Error(t("participantAckRequired"));
    if (startCancelled) return { cancelled: true };

    await setState({
        state: STATE.awaitingPicker,
        meetingTarget: target,
        tabId: tabId ?? null,
        platformHint: platformHint ?? null,
        error: null,
        startConnectionError: false,
        micWarning: null,
        meetingBannerErrorDismissed: false,
        stopped: false,
        captureStopping: false,
        stopReason: "user",
        blocked: false,
        uploadNotice: null,
        recoverablePrefix: null,
        popupFolder: fromPopup && folderId !== undefined ? { folderId, folderLabel: folderLabel ?? null, folderScope: folderScope ?? null } : null,
        withoutMicrophone,
    });
    if (startCancelled) {
        await resetState(current);
        return { cancelled: true };
    }

    const useTab =
        !forceDesktop && typeof tabId === "number" && (fromPopup || Boolean(platformHint));
    if (!useTab) {
        return openDesktopRecorder({ tabId, target, platformHint, auto, noticeAcknowledgedAt, withoutMicrophone, startPath });
    }

    return startCapturedRecording({
        tabId,
        target,
        platformHint,
        auto,
        noticeAcknowledgedAt,
        captureMode: "tab",
        withoutMicrophone,
        preparedAuth: auth,
        startPath,
    });
}

async function startCapturedRecording({
    tabId,
    target,
    platformHint,
    auto = false,
    noticeAcknowledgedAt,
    captureMode,
    withoutMicrophone = false,
    captureWindowId = null,
    pickerRequestId = null,
    preparedAuth,
    startPath,
}) {
    const settings = await getSettings();
    startPath ??= recordingStartPath(settings);
    if (!sameConnection(startPath, settings) || !settings.hasApiKey) throw new Error(t("connectFirst"));
    if (!settings.dataUseAcknowledgedAt) throw new Error(t("dataUseRequired"));
    const selection = (await chrome.storage.session.get(AGENDA_SELECTION_KEY))[AGENDA_SELECTION_KEY];
    const selectedAgenda = supportsAgendas(settings) && selection?.serverUrl === settings.serverUrl && selection.connectionId === settings.connectionId ? selection.agenda : null;
    const agendaExplicit = supportsAgendas(settings) && selection?.serverUrl === settings.serverUrl && selection.connectionId === settings.connectionId && selection.explicit === true;
    const popupFolder = (await getState()).popupFolder;
    const { recipient, legacySupported } = startPath;
    const protocol = recipient ? 2 : 1;
    const selectedFolder = popupFolder ?? (selectedAgenda ? agendaFolder(selectedAgenda) : {});
    const disconnected = await serverUnavailable(settings);
    const connecting = !recipient && disconnected;
    if (startCancelled) return { cancelled: true };
    if (!recipient && !legacySupported && !connecting) {
        await setState({ state: STATE.error, error: t("encryptedServerRequired") });
        throw new Error(t("encryptedServerRequired"));
    }
    const auth = preparedAuth ?? await recorderAuth(settings);
    if (!sameConnection(auth, settings)) throw new Error(t("connectFirst"));
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
        clientVersion: `${chrome.runtime.getManifest().version}+${clientRecordingId}`,
        timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
        noticeAcknowledgedAt: noticeAcknowledgedAt ?? startedAt,
        folderId: "folderId" in selectedFolder ? selectedFolder.folderId ?? undefined : settings.folderId ?? undefined,
        ...(settings.serverDefaults?.sessionAgenda === true && selectedAgenda?.permissions?.edit !== false && selectedAgenda ? { agendaId: selectedAgenda.id } : {}),
    };
    const tab = await requireStartTab(tabId, target);
    const body = { ...sessionBody, ...sessionRoom(settings, tab) };
    const { folderId: _startFolder, agendaId: liveAgendaId, meetCode: _room, ...sealedIntent } = body;
    target ??= meetingTarget(tab?.url);
    let folderId = "folderId" in selectedFolder ? selectedFolder.folderId : settings.folderId ?? null;
    let folderLabel = "folderId" in selectedFolder ? selectedFolder.folderLabel ?? null : settings.folderLabel ?? null;
    let folderScope = "folderScope" in selectedFolder ? selectedFolder.folderScope ?? null : settings.folderScope ?? null;
    const folder = () => ({
        agendaId: selectedAgenda?.id ?? null,
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
    });
    const source = {
        captureMode, captureWindowId, pickerRequestId,
        tabId: tabId ?? null, meetingTarget: target, platformHint: platformHint ?? null,
        autoStarted: auto, withoutMicrophone,
    };
    const storageWarning = recipient ? await lowCaptureStorage() : false;
    const { captureId } = await withPairingBinding(async () => {
        const latest = await getSettings();
        if (!sameConnection(settings, latest) ||
            (recipient && latest.serverDefaults?.accountId !== recipient.accountId)) throw new Error(t("connectFirst"));
        return createCapture({
            ...folder(), platformHint: source.platformHint, clientRecordingId, startedAt,
            serverUrl: settings.serverUrl, pairing: pairingFor(settings), protocol,
            ...(recipient ? { createIntent: sealedIntent, liveAgendaId, bufferedOffline: disconnected } : {}),
        });
    });
    const owner = { captureId };
    const pending = await getState();
    if (startCancelled || pending.state !== STATE.awaitingPicker ||
        (captureMode === "desktop" && pending.pickerRequestId !== pickerRequestId)) {
        await removeCapture(captureId);
        return { cancelled: true };
    }
    await setState({
        ...source, captureId, bufferId: captureId, sessionId: null, startPath: null, connecting, protocol,
        storedParts: 0, bufferedBytes: 0, bufferedOffline: disconnected, localStorageWarning: storageWarning,
    });
    if (startCancelled) {
        const current = await getState();
        if (sameCapture(current, owner)) await queueCaptureStop(current, "user");
        else await removeCapture(captureId);
        return { cancelled: true };
    }
    let session;
    try {
        if (recipient) {
            await setState({
                ...folder(), ...source, state: STATE.recording, sessionId: null, startedAt,
                agendaTitle: selectedAgenda?.title ?? null, chunkCount: 0, uploaded: [],
            }, owner);
        } else {
            session = await withCapture(captureId, async () => {
                if (stopRequests.has(captureId)) return null;
                let opened;
                try {
                    opened = await sendCreateIntent(captureId, auth, body);
                } catch (error) {
                    if (!(folderId && error?.status === 400 && error?.field === "folderId")) throw error;
                    folderId = null;
                    folderLabel = null;
                    folderScope = null;
                    if (!selectedFolder.folderId) await saveSettings({ folderId, folderLabel, folderScope });
                    const fallbackBody = { ...body };
                    delete fallbackBody.folderId;
                    if (stopRequests.has(captureId)) return null;
                    opened = await sendCreateIntent(captureId, auth, fallbackBody);
                }
                await updateLocalMeta(captureId, folder(), owner);
                if (stopRequests.has(captureId)) return null;
                if (opened.encryption?.protocol !== 1 || !opened.encryption.key) {
                    throw new Error(t("encryptedServerRequired"));
                }
                await setState({
                    ...folder(), ...source,
                    agendaTitle: selectedAgenda?.title ?? null,
                    state: STATE.recording,
                    connecting: false,
                    sessionId: opened.id,
                    startedAt,
                    chunkCount: 0,
                    stopped: false,
                    captureStopping: false,
                    stopReason: "user",
                    uploaded: [],
                    jobId: null,
                    serverCompleting: false,
                    finalizingAt: null,
                }, owner);
                return opened;
            });
            if (!session || stopRequests.has(captureId)) return { cancelled: true };
        }
        const maxSessionBytes = validSessionLimit(session?.limits?.max_session_bytes) ??
            validSessionLimit(settings.serverDefaults?.maxSessionBytes);
        await requireStartTab(tabId, target);

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
            if (!canStartCapture(await getState(), owner)) {
                await closeUnusedOffscreen();
                return { cancelled: true };
            }
            await requireStartTab(tabId, target);
            const streamId = await getTabMediaStreamId(tabId);
            if (!recipient) await requireStartTab(tabId, target);
            if (!recipient && !canStartCapture(await getState(), owner)) {
                await closeUnusedOffscreen();
                return { cancelled: true };
            }
            if (!streamId) {
                await closeOffscreen();
                await withCapture(captureId, () => cleanFailedStart(captureId, auth));
                if (stopRequests.has(captureId)) return { cancelled: true };
                return openDesktopRecorder({ tabId, target, platformHint, auto, noticeAcknowledgedAt, withoutMicrophone, startPath });
            }
            response = await messageOffscreen("start", {
                captureId,
                clientRecordingId,
                ...(recipient ? { recipient } : { captureKey: session.encryption.key }),
                maxSessionBytes: maxSessionBytes ?? undefined,
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
            await requireStartTab(tabId, target);
            if (!canStartCapture(await getState(), owner)) return { cancelled: true };
            response = await messageDesktop("start", pickerRequestId, {
                captureId,
                clientRecordingId,
                ...(recipient ? { recipient } : { captureKey: session.encryption.key }),
                maxSessionBytes: maxSessionBytes ?? undefined,
                captureMode,
                channelMode: settings.channelMode,
                microphoneId: settings.microphoneId,
                withoutMicrophone,
            });
        }
        if (!canStartCapture(await getState(), owner)) return { cancelled: true };
        if (!response?.ok) {
            throw new Error(response?.error || t("couldNotCapture"));
        }

        await chrome.storage.session.remove(AGENDA_SELECTION_KEY);
        if (tabId != null) void syncMeetingBanner(tabId).catch(() => {});
        if (recipient) {
            if (disconnected) void ensureConnectionAlarm().catch(() => {});
            if (storageWarning) void notify(t("offlineStorageLow"), t("offlineStorageWarning")).catch(() => {});
        } else {
            void cacheSessionLimit(settings, session).catch(() => {});
            void pumpUploads().catch(() => {});
        }
        return { sessionId: session?.id ?? null };
    } catch (error) {
        const cancelled = !canStartCapture(await getState(), owner);
        if (cancelled) return { cancelled: true };
        captureLeases.end(captureId);
        if (captureMode === "tab" && (session || recipient)) await closeOffscreen().catch(() => {});
        await withCapture(captureId, async () => {
            if (!sameCapture(await getState(), owner)) return;
            const connectionFailed = isConnectionError(error);
            const meta = await readLocalMeta(captureId);
            const stored = await listChunkIndices(captureId, true);
            if (stored.length) {
                const stopped = await markStopped(captureId, { stopReason: "error" });
                await updateCapture(captureId, { blocked: true });
                await setState({ blocked: true, chunkCount: stopped?.chunkCount ?? 0 }, owner);
            } else if (meta?.createOutcome === "unknown") {
                await markStopped(captureId, { stopReason: "error" });
                await updateCapture(captureId, { discardRequested: true });
                await setState({ captureId: null, bufferId: null, sessionId: null }, owner);
                void ensureConnectionAlarm().catch(() => {});
                void ensureUploadRetryAlarm().catch(() => {});
            } else {
                await cleanFailedStart(captureId, auth).catch(async () => {
                    await markStopped(captureId, { stopReason: "error" });
                    await updateCapture(captureId, { discardRequested: true });
                    await ensureUploadRetryAlarm();
                });
            }
            await setState({
                state: STATE.error, stopped: true, captureWindowId: null, captureStopping: false,
                connecting: false, startConnectionError: connectionFailed,
                error: connectionFailed ? null : error?.message ?? String(error),
                ...(connectionFailed ? source : {}),
            });
        });
        if (captureMode === "desktop" && !isConnectionError(error)) {
            await chrome.windows.remove(captureWindowId).catch(() => {});
        }
        throw error;
    }
}

function isLiveCapture(state) {
    return Boolean(captureIdOf(state) && !state.stopped &&
        (state.state === STATE.recording || state.state === STATE.awaitingPicker ||
            state.captureMode === "tab" || (state.captureMode === "desktop" && state.captureWindowId != null)));
}

const stopRequests = new Map();

const roomRecorderLookup = createRoomRecorderLookup({
    authFor: recorderAuth,
    async isIdle() {
        const state = await getState();
        return !starting && state.state === STATE.idle;
    },
});
const captureLeases = createCaptureLeases({
    async liveCapture(captureId) {
        const state = await getState();
        return state.captureId === captureId && state.captureMode === "tab" &&
            state.tabId != null && state.sessionId && state.state === STATE.recording &&
            !state.stopped && !state.captureStopping && !stopRequests.has(captureId) ? state : null;
    },
    ping: (state) => messageCaptureHost(state, "ping"),
    authFor: (meta, settings) => {
        if (!capturePairingMatches(meta, settings)) throw new Error(t("connectFirst"));
        return recorderAuth(settings);
    },
});
onCaptureChunk(null, ({ detail }) => void captureLeases.chunk(detail.captureId));

function canStartCapture(state, owner) {
    return sameCapture(state, owner) && !state.stopped && !state.captureStopping &&
        !startCancelled && !stopRequests.has(owner.captureId);
}

async function stopRecording(reason = "user", expected = null) {
    const state = await getState();
    if (expected && ((expected.tabId !== undefined && state.tabId !== expected.tabId) || !controlMatchesCapture(state, expected))) throw new Error(t("unrecognizedSender"));
    if (!captureIdOf(state) && (starting || state.state === STATE.awaitingPicker)) {
        startCancelled = true;
        if (state.state === STATE.awaitingPicker) {
            await resetState(state);
            if (state.captureWindowId != null) await chrome.windows.remove(state.captureWindowId).catch(() => {});
        }
        return { ok: true };
    }
    if (!isLiveCapture(state)) return { ok: true };
    return queueCaptureStop(state, reason);
}

function queueCaptureStop(state, reason, hostClosed = false) {
    const captureId = captureIdOf(state);
    const pending = stopRequests.get(captureId);
    if (pending) {
        return hostClosed
            ? pending.catch(() => {}).then(() => queueCaptureStop(state, reason, true))
            : pending;
    }
    captureLeases.end(captureId);
    const stopped = withCapture(captureId, async () => {
        const current = await getState();
        if (!sameCapture(current, state) || !isLiveCapture(current)) return { ok: true };
        if (hostClosed) {
            await sealMissingHost(current, reason);
            return { ok: true };
        }
        return requestCaptureStop(current, reason);
    }).finally(() => {
        stopRequests.delete(captureId);
        void healStoppedUpload().catch(() => {});
    });
    stopRequests.set(captureId, stopped);
    return stopped;
}

function messageCaptureHost(state, type) {
    const payload = state.captureId || type === "ping" ? { captureId: captureIdOf(state) } : undefined;
    return state.captureMode === "desktop"
        ? messageDesktop(type, state.pickerRequestId, payload)
        : messageOffscreen(type, payload);
}

async function requestCaptureStop(state, reason) {
    if (state.captureStopping) return { ok: true };
    if (state.tabId != null) await chrome.alarms.clear(`${ALARMS.quietPrefix}${state.tabId}`);
    const captureId = captureIdOf(state);
    captureLeases.end(captureId);
    if (state.captureId) {
        await writeCaptureStop(captureId, { stopReason: reason, stopRequestedAt: new Date().toISOString() });
    }
    if (!(await setState({ stopReason: reason, captureStopping: true }, state))) return { ok: true };
    if (state.state === STATE.awaitingPicker) {
        await sealMissingHost(state, reason, { report: false });
        if (state.captureWindowId != null) await chrome.windows.remove(state.captureWindowId).catch(() => {});
        return { ok: true };
    }
    const response = await messageCaptureHost(state, "stop").catch(() => null);
    if (response?.ok === true) return { ok: true };
    if (state.captureId) {
        const host = await messageCaptureHost(state, "ping").catch(() => null);
        if (host?.captureId !== captureId) {
            await sealMissingHost(state, reason);
            if (state.captureMode === "tab" && !host?.captureId) await closeOffscreen();
            if (state.captureMode === "desktop" && !host?.captureId && state.captureWindowId != null) {
                await chrome.windows.remove(state.captureWindowId).catch(() => {});
            }
            return { ok: true };
        }
        await safe(writeCaptureStop(captureId, { stopRequestedAt: null }));
    }
    await setState({ captureStopping: false }, state);
    return { ok: false, error: response?.error || t("somethingWrong") };
}

async function closeUnusedOffscreen() {
    const host = await messageOffscreen("ping").catch(() => null);
    if (!host?.captureId) await closeOffscreen();
}

let recordingMetadataUpdates = Promise.resolve();
let recordingAgendaAnnouncements = Promise.resolve();

function updateLocalMeta(captureId, patch, owner) {
    return updateCapture(captureId, patch, owner ? async () => sameCapture(await getState(), owner) : undefined);
}

async function sendCreateIntent(captureId, auth, body) {
    const intent = {
        clientRecordingId: body.clientRecordingId,
        startedAt: body.startedAt,
        noticeAcknowledgedAt: body.noticeAcknowledgedAt,
        clientVersion: body.clientVersion,
        mimeType: body.mimeType,
        channelLayout: body.channelLayout,
    };
    if (!(await updateCapture(captureId, { createIntent: intent, createOutcome: "unknown" }))) {
        throw new Error(t("recoveryUnavailable"));
    }
    let session;
    try {
        session = await createSession(auth, body);
    } catch (error) {
        if (error?.kind === "server" && ![409, 500, 502, 503, 504].includes(error.status)) {
            await updateCapture(captureId, { createOutcome: "refused" });
        }
        throw error;
    }
    await attachSession(captureId, session.id, { keyExpiresAt: session.encryption?.expires_at });
    return session;
}

async function cacheSessionLimit(settings, session) {
    const maxSessionBytes = validSessionLimit(session.limits?.max_session_bytes);
    if (!maxSessionBytes) return;
    await withPairingBinding(async () => {
        const current = await getSettings();
        if (!sameConnection(settings, current) || !current.serverDefaults ||
            current.serverDefaults.accountId !== settings.serverDefaults?.accountId ||
            current.serverDefaults.maxSessionBytes === maxSessionBytes) return;
        await chrome.storage.local.set({
            [STORAGE_KEYS.serverDefaults]: { ...current.serverDefaults, maxSessionBytes },
        });
    });
}

async function markSealedUnavailable(settings) {
    await withPairingBinding(async () => {
        const latest = await getSettings();
        if (!sameConnection(settings, latest) ||
            latest.serverDefaults?.fetchedAt !== settings.serverDefaults?.fetchedAt) return;
        await chrome.storage.local.set({
            [STORAGE_KEYS.serverDefaults]: {
                ...latest.serverDefaults, offlineRecording: false, sealedProbeNeeded: true,
            },
        });
    });
    void probeConnection().catch(() => {}).finally(() => void ensureConnectionAlarm().catch(() => {}));
}

async function refuseBufferedCapture(captureId, error, view = null, { stop = true, owner } = {}) {
    const state = owner ?? await getUploadState(view);
    const refusal = { code: error.code, message: error.message };
    if (!(await updateCapture(captureId, { blocked: true, refusal }))) return;
    void publishPendingChange();
    if (captureIdOf(state) !== captureId) return;
    const message = sealedRefusalMessage(refusal);
    const refused = await setUploadState(view, (current) => ({
        blocked: true,
        reconcilePending: false,
        ...(isLiveCapture(current) ? { uploadNotice: message } : { state: STATE.error, error: message }),
    }), state);
    if (refused && isLiveCapture(refused) && stop) void queueCaptureStop(state, "error").catch(() => {});
}

const sealedCreations = new Map();

function openSealedCapture(captureId, meta, settings) {
    let work = sealedCreations.get(captureId);
    if (!work) {
        work = openSealedCaptureOnce(captureId, meta, settings).finally(() => sealedCreations.delete(captureId));
        sealedCreations.set(captureId, work);
    }
    return work;
}

async function openSealedCaptureOnce(captureId, meta, settings) {
    if (!meta.sealing || !meta.createIntent || meta.blocked || meta.discardRequested ||
        await serverUnavailable(settings)) return null;
    if (!sealedRecipient(settings)) {
        void ensureConnectionAlarm().catch(() => {});
        return null;
    }
    if (meta.nextRetryAt && Date.parse(meta.nextRetryAt) > Date.now()) {
        await scheduleRetryAt(Date.parse(meta.nextRetryAt));
        return null;
    }
    const auth = await captureAuth(captureId, meta, settings, { forLookup: true });
    const requested = await updateCapture(captureId, (meta) => meta.discardRequested ? null : { createOutcome: "unknown" });
    if (!requested || requested.discardRequested) return null;
    const current = await getState();
    const tab = captureIdOf(current) === captureId && current.tabId != null
        ? await chrome.tabs.get(current.tabId).catch(() => null) : null;
    const latest = await getSettings();
    const capture = await readLocalMeta(captureId);
    if (capture?.serverSessionId || !sameConnection(settings, latest) || !capture || !capturePairingMatches(capture, latest) ||
        capture.discardRequested || capture.cleanupPending || !sealedRecipient(latest)) return null;
    const active = await getState();
    if (captureDiscards.has(captureId)) return null;
    const live = captureIdOf(active) === captureId && isLiveCapture(active) &&
        !active.captureStopping && !capture.stoppedAt && !capture.stopRequestedAt && !stopRequests.has(captureId);
    const body = {
        ...meta.createIntent,
        encryption: meta.sealing,
        ...(live ? {
            folderId: capture.startFolderId ?? undefined,
            liveAgendaId: capture.agendaId === meta.liveAgendaId ? meta.liveAgendaId : undefined,
            ...sessionRoom(latest, sameMeetingTarget(active.meetingTarget, tab?.url) ? tab : null),
        } : {}),
    };
    try {
        const session = await createSealedSession(auth, body);
        if (!(await attachSession(captureId, session.id, {
            nextRetryAt: null, retryAttempt: 0, uploadedParts: session.received_chunks?.length ?? 0,
        }))) return null;
        void cacheSessionLimit(settings, session).catch(() => {});
        return session;
    } catch (error) {
        if (error.kind === "capability") {
            await scheduleUploadRetry(captureId, error);
            await markSealedUnavailable(settings);
        } else if (error.kind === "server" && error.status !== 429 && error.status < 500) {
            await updateCapture(captureId, { createOutcome: "refused" });
            await refuseBufferedCapture(captureId, error, null, { owner: active });
        } else {
            await updateCapture(captureId, { bufferedOffline: true });
            if (captureIdOf(active) === captureId) await setUploadState(null, { bufferedOffline: true }, active);
            await scheduleUploadRetry(captureId, error);
        }
        return null;
    }
}

async function bindForegroundSealed(state) {
    const captureId = captureIdOf(state);
    const meta = await readLocalMeta(captureId);
    if (!meta) return false;
    const settings = await getSettings();
    if (!capturePairingMatches(meta, settings)) return false;
    const session = meta.serverSessionId
        ? await getSession(await captureAuth(captureId, meta, settings), meta.serverSessionId)
        : await openSealedCapture(captureId, meta, settings);
    const current = await getState();
    if (!session || !sameUploadAttempt(current, state)) return false;
    if (current.sessionId) return current.sessionId === session.id && session.status === "open";
    const uploaded = session.received_chunks ?? [];
    const attached = await setUploadState(null, {
        sessionId: session.id, uploaded, reconcilePending: session.status !== "open",
    }, state);
    if (!attached) return false;
    if (isLiveCapture(attached)) {
        void captureLeases.chunk(captureId);
    }
    if (session.status !== "open") {
        void reconcileBufferedRecordings().catch(() => {});
        return false;
    }
    return true;
}

async function applyRecordingFolder(state, folder, remember = true, matches = sameCapture) {
    if (!(await updateLocalMeta(captureIdOf(state), folder, state)) ||
        !(await setState(folder, state, matches))) return false;
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
        if (!controlMatchesCapture(state, message) || state.state !== STATE.recording ||
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
let uploadSlot = Promise.resolve();
let sealedChunkUpload;

function useUploadSlot(run) {
    const work = uploadSlot.catch(() => {}).then(run);
    uploadSlot = work;
    return work;
}

function getUploadState(view) {
    return view ? Promise.resolve(view.state) : getState();
}

async function setUploadState(view, patch, owner) {
    if (!owner || captureDiscards.has(captureIdOf(owner))) return;
    if (!view) return setState(patch, owner, (current, expected) =>
        sameUploadAttempt(current, expected) && !captureDiscards.has(captureIdOf(expected)));
    if (!sameUploadAttempt(view.state, owner)) return null;
    view.state = { ...view.state, ...(typeof patch === "function" ? patch(view.state) : patch) };
    return view.state;
}

function pumpUploads() {
    pumpRequested = true;
    if (bufferTransitionCount) return uploadPump ?? Promise.resolve();
    if (!uploadPump) {
        uploadPump = useUploadSlot(async () => {
            try {
                do {
                    pumpRequested = false;
                    await pumpUploadsOnce();
                } while (pumpRequested && !bufferTransitionCount);
            } finally {
                uploadPump = null;
            }
        });
    }
    return uploadPump;
}

async function healStoppedUpload() {
    const state = await getState();
    if (!state.stopped || state.state === STATE.error ||
        (!canPumpUploads(state) && !(state.protocol === 2 && !state.sessionId && !state.blocked))) return false;
    await pumpUploads();
    return true;
}

async function pumpUploadsOnce(view = null) {
    let owner;
    let sealedUpload;
    try {
        for (;;) {
            const state = await getUploadState(view);
            owner = state;
            const bufferId = captureIdOf(state);
            if (state.protocol === 2 && bufferId && sealedUpload?.captureId !== bufferId) {
                sealedUpload = { captureId: bufferId, controller: new AbortController() };
                sealedChunkUpload = sealedUpload;
            }
            const signal = sealedUpload?.captureId === bufferId ? sealedUpload.controller.signal : null;
            if (signal?.aborted || captureDiscards.has(bufferId)) return;
            if (await serverUnavailable()) break;
            if (!view && !state.sessionId && state.protocol === 2 && captureIdOf(state) && !state.blocked) {
                if (!(await bindForegroundSealed(state))) break;
                continue;
            }
            if (!canPumpUploads(state)) break;
            const settings = await getSettings();
            const meta = await readLocalMeta(bufferId);
            if (!meta || meta.cleanupPending || meta.discardRequested) break;
            const cutoff = meta.completeIntent ? meta.completeIntent.truncatedAtChunk : meta.truncatedAtChunk ?? state.truncatedAtChunk;
            const chunkCount = meta.completeIntent?.chunkCount ?? meta.chunkCount ?? state.chunkCount;
            const auth = await captureAuth(bufferId, meta, settings);
            if (meta?.nextRetryAt && Date.parse(meta.nextRetryAt) > Date.now()) {
                await scheduleRetryAt(Date.parse(meta.nextRetryAt));
                break;
            }

            const uploaded = new Set(state.uploaded);
            const receivedPrefix = verifiedPrefix([], uploaded) + 1;
            let expectedChunks = cutoff ?? Math.max(chunkCount, (meta.highestCommittedIndex ?? -1) + 1);
            const verifiedStop = Number.isInteger(meta.highestCommittedIndex) && !captureHasGap(meta);
            if (state.stopped && receivedPrefix >= expectedChunks && (cutoff || verifiedStop)) {
                await finalize(cutoff, view);
                break;
            }
            const stored = await listChunkIndices(bufferId, state.stopped);
            if (state.stopped && !cutoff) {
                expectedChunks = await checkStoppedBuffer(view, state, meta, stored, uploaded);
                if (expectedChunks === null) break;
            }
            if (state.stopped && receivedPrefix >= expectedChunks) {
                await finalize(cutoff, view);
                break;
            }
            const pending = stored.filter((index) => !uploaded.has(index) && (!state.stopped || index < expectedChunks));

            if (pending.length === 0) {
                if (state.stopped) {
                    await setUploadState(view, {
                        state: STATE.error,
                        blocked: true,
                        recoverablePrefix: receivedPrefix || null,
                        error: `Encrypted buffer is missing chunk ${receivedPrefix}`,
                    }, state);
                }
                break;
            }

            let progressed = false;
            for (const index of pending) {
                try {
                    const blob = await readChunk(bufferId, index);
                    if (blob.size === 0) break;
                    const hash = await sha256Hex(blob);
                    const latest = await getSettings();
                    if (signal?.aborted || !sameConnection(auth, latest) || !capturePairingMatches(meta, latest)) return;
                    if (signal) await uploadChunk(auth, state.sessionId, index, blob, hash, signal);
                    else await uploadChunk(auth, state.sessionId, index, blob, hash);
                    const now = await getUploadState(view);
                    if (signal?.aborted || !sameUploadAttempt(now, state)) return;
                    await setUploadState(view, {
                        uploaded: [...new Set([...now.uploaded, index])],
                        uploadNotice: null,
                    }, state);
                    if (meta.captureId) {
                        await updateCapture(bufferId, { uploadedParts: now.uploaded.length + 1 });
                        if (view) void publishPendingChange();
                    }
                    if (meta?.nextRetryAt) {
                        await updateLocalMeta(bufferId, {
                            retryAttempt: 0,
                            nextRetryAt: null,
                        });
                    }
                    progressed = true;
                } catch (error) {
                    if (signal?.aborted || !sameUploadAttempt(await getUploadState(view), state)) return;
                    if (error?.status === 409 && state.captureId && error.message?.startsWith("Cannot upload chunks to a session that is ")) {
                        await setUploadState(view, { reconcilePending: true }, state);
                        await ensureUploadRetryAlarm();
                        break;
                    }
                    if (error?.status && ![429, 500, 502, 503, 504].includes(error.status)) {
                        if (error.kind === "server") {
                            await refuseBufferedCapture(bufferId, error, view, { stop: false, owner: state });
                        }
                        await updateCapture(bufferId, { blocked: true });
                        await setUploadState(view, {
                            ...(isLiveCapture(await getUploadState(view))
                                ? { uploadNotice: retryErrorMessage(error) }
                                : { state: STATE.error, error: retryErrorMessage(error) }),
                            blocked: true,
                            recoverablePrefix: [409, 413, 422].includes(error.status) && index > 0 ? index : null,
                        }, state);
                    } else {
                        const offline = isConnectionError(error);
                        if (offline && meta.protocol === 2) await updateCapture(bufferId, { bufferedOffline: true });
                        await setUploadState(view, {
                            uploadNotice: offline ? null : retryErrorMessage(error),
                            ...(offline ? { bufferedOffline: true } : {}),
                        }, state);
                        await scheduleUploadRetry(captureIdOf(state), error);
                    }
                    break;
                }
            }
            if (!progressed) break;
        }
    } catch (error) {
        const state = await getUploadState(view);
        if (!sameUploadAttempt(state, owner)) return;
        if (isConnectionError(error)) {
            await scheduleUploadRetry(captureIdOf(state), error);
            return;
        }
        const message = error?.message ?? t("recoveryUnavailable");
        if (view) await scheduleUploadRetry(captureIdOf(state), error);
        await setUploadState(view, isLiveCapture(state)
            ? { blocked: true, uploadNotice: message }
            : { state: STATE.error, blocked: true, error: message }, state);
    } finally {
        if (sealedChunkUpload === sealedUpload) sealedChunkUpload = null;
    }
}

async function checkStoppedBuffer(view, state, meta, stored, uploaded) {
    const chunkCount = Math.max(state.chunkCount ?? 0, meta.chunkCount ?? 0, (meta.highestCommittedIndex ?? -1) + 1, Math.max(-1, ...stored, ...uploaded) + 1);
    const prefix = verifiedPrefix(stored, uploaded) + 1;
    if (prefix >= chunkCount) {
        if (captureHasGap(meta) || (meta.chunkCount ?? state.chunkCount) < chunkCount) {
            await markStopped(captureIdOf(state), { stopReason: meta.stopReason ?? state.stopReason, chunkCount, uploaded });
        }
        return chunkCount;
    }
    await markStopped(captureIdOf(state), { stopReason: meta.stopReason ?? state.stopReason, chunkCount, uploaded });
    await setUploadState(view, {
        state: STATE.error, blocked: true, chunkCount, recoverablePrefix: prefix || null,
        error: t("recordingBufferGap"),
    }, state);
    void publishPendingChange();
    return null;
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
    return sameCapture(current, expected) && current?.sessionId === expected?.sessionId;
}

function sameUploadAttempt(current, expected) {
    return Boolean(expected) && sameUploadOwner(current, expected) && current.finalizingAt === expected.finalizingAt &&
        current.finalizationAttempt === expected.finalizationAttempt;
}

function newFinalizationAttempt() {
    return { finalizationAttempt: crypto.randomUUID(), finalizingAt: new Date().toISOString() };
}

function wasQueuedDuringCapture(requested, current) {
    return requested?.state === STATE.recording && !requested.stopped && sameUploadOwner(current, requested);
}

const finalizations = new Map();

function completeAcknowledged(result) {
    return result.status === "completing" || result.status === "completed" ||
        (result.status === undefined && Boolean(result.job_id));
}

function completeMayHaveDispatched(meta) {
    return Boolean(meta?.completeDispatched || meta?.completeIntent);
}

async function dispatchComplete(captureId, auth, sessionId, body) {
    const meta = await updateCapture(captureId, (current) =>
        current.completeDispatched || current.discardRequested ? null : { completeDispatched: true },
    () => !captureDiscards.has(captureId));
    if (!meta || meta.discardRequested || captureDiscards.has(captureId)) return null;
    return completeSession(auth, sessionId, body);
}

async function finalize(truncatedAtChunk = null, view = null) {
    const state = await getUploadState(view);
    if (!state.sessionId || !state.stopped || isPollingFinalization(state)) return;
    const captureId = captureIdOf(state);
    let work = finalizations.get(captureId);
    if (!work) {
        work = finalizeAfterMetadata(state, truncatedAtChunk, view).finally(() => finalizations.delete(captureId));
        finalizations.set(captureId, work);
    }
    return work;
}

async function finalizeAfterMetadata(state, truncatedAtChunk, view) {
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
    return withCapture(captureIdOf(state), () => finalizeOnce(state, truncatedAtChunk, view));
}

async function finalizeOnce(state, truncatedAtChunk, view) {
    const ready = await getUploadState(view);
    if (!sameUploadAttempt(ready, state) || isPollingFinalization(ready) || ready.blocked) return;
    const captureId = captureIdOf(state);
    captureLeases.end(captureId);
    const meta = await readLocalMeta(captureId);
    if (!meta || meta.cleanupPending || meta.discardRequested || (!truncatedAtChunk && captureHasGap(meta))) return;

    const attempt = await setUploadState(view, { state: STATE.finalizing, ...newFinalizationAttempt() }, ready);
    if (!attempt) return;
    const ownsAttempt = async () => {
        const local = await readLocalMeta(captureId);
        return local && !local.discardRequested && sameUploadAttempt(await getUploadState(view), attempt) &&
            !captureDiscards.has(captureId);
    };
    try {
        const settings = await getSettings();
        const auth = await captureAuth(captureId, meta, settings);
        const snapshot = await updateCapture(captureId, (current) => {
            const metadata = { ...ready, ...current };
            if (current.completeIntent && (truncatedAtChunk || current.completeIntent.chunkCount === metadata.chunkCount)) return null;
            const stoppedAt = current.stoppedAt ?? current.stopRequestedAt ?? attempt.finalizingAt;
            return {
                stoppedAt,
                completeIntent: {
                    chunkCount: metadata.chunkCount,
                    ...(truncatedAtChunk ? { truncatedAtChunk } : {}),
                    endedAt: stoppedAt,
                    stopReason: metadata.stopReason,
                    ...(meta.protocol === 2 && metadata.agendaId
                        ? { agendaId: metadata.agendaId }
                        : agendaCompletion(settings, metadata)),
                    ...((meta.protocol === 2 || (settings.serverDefaults?.recordingFolderOverride === true &&
                        metadata.recordingFolderOverride === true))
                        ? { folderId: metadata.folderId ?? null }
                        : {}),
                },
            };
        });
        if (!snapshot || captureDiscards.has(captureId)) return;
        const body = snapshot.completeIntent;
        let result;
        try {
            result = await dispatchComplete(captureId, auth, state.sessionId, body);
        } catch (error) {
            if (!(await ownsAttempt())) return;
            if (error?.status === 422 && error?.field === "chunkCount") {
                const remote = await getSession(auth, state.sessionId);
                const received = remote.received_chunks;
                if (remote.status === "open" && Array.isArray(received) &&
                    verifiedPrefix([], received) + 1 < (body.truncatedAtChunk ?? body.chunkCount)) {
                    await setUploadState(view, { uploaded: received }, attempt);
                    await scheduleUploadRetry(captureId, error);
                    return;
                }
            }
            if ("folderId" in body && error?.status === 400 && error?.field === "folderId") {
                const fallbackBody = { ...body };
                delete fallbackBody.folderId;
                await updateCapture(captureId, { completeIntent: fallbackBody });
                const folder = {
                    folderId: state.startFolderId ?? null,
                    folderLabel: state.startFolderLabel ?? null,
                    folderScope: state.startFolderScope ?? null,
                };
                if (!view) await applyRecordingFolder(attempt, folder, !ready.agendaExplicit || !ready.agendaId, sameUploadAttempt);
                else {
                    await updateLocalMeta(captureId, folder);
                    await setUploadState(view, folder, attempt);
                }
                result = await dispatchComplete(captureId, auth, state.sessionId, fallbackBody);
            } else {
                throw error;
            }
        }
        if (!result || !(await ownsAttempt())) return;
        const agendaUnavailable = result.agenda?.attached === false && result.agenda.reason === "unavailable";
        if (agendaUnavailable) await updateLocalMeta(captureIdOf(state), { agendaUnavailable });
        const polling = await setUploadState(view, {
            jobId: result.job_id ?? null,
            serverCompleting: result.status === "completing" || result.status === "completed",
            agendaUnavailable,
        }, attempt);

        if (polling) {
            if (completeAcknowledged(result)) await updateCapture(captureId, { completeIntent: null });
            else if (result.status === "open") {
                await scheduleUploadRetry(captureId);
                return;
            }
            await pollFinalizationOnce(polling, auth, view);
        }
    } catch (error) {
        if (!(await ownsAttempt())) return;
        const blocked = Boolean(error?.status && ![429, 500, 502, 503, 504].includes(error.status));
        if (!isConnectionError(error)) {
            await setUploadState(view, {
                state: STATE.error,
                blocked,
                error: retryErrorMessage(error, t("finalizeFailed")),
            }, attempt);
        }
        if (blocked) await updateCapture(captureId, {
            blocked: true,
            ...([400, 422].includes(error.status) ? { completeIntent: null } : {}),
        });
        else await scheduleUploadRetry(captureId, error);
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
    await scheduleRetryAt(Date.parse(nextRetryAt));
}

async function scheduleRetryAt(when) {
    const existing = await chrome.alarms.get(ALARMS.uploadRetry);
    if (existing?.scheduledTime <= when) return;
    await chrome.alarms.create(ALARMS.uploadRetry, { when });
}

const pendingReconciliations = new Map();

async function ensureUploadRetryAlarm(delayInMinutes = 0.5) {
    const existing = await chrome.alarms.get(ALARMS.uploadRetry);
    if (existing && existing.scheduledTime <= Date.now() + delayInMinutes * 60000) return;
    await chrome.alarms.create(ALARMS.uploadRetry, { delayInMinutes });
}

function pollFinalization(state, auth) {
    const captureId = captureIdOf(state);
    const pending = pendingReconciliations.get(captureId);
    if (pending) return pending;
    const work = withCapture(captureId, async () => {
        const latest = await getState();
        if (!sameUploadAttempt(latest, state) || !isPollingFinalization(latest)) return;
        const settings = await getSettings();
        const meta = await readLocalMeta(captureId);
        const verifiedAuth = await captureAuth(captureId, meta, settings);
        if (sameConnection(auth, verifiedAuth)) await pollFinalizationOnce(state, verifiedAuth);
    }).finally(() => pendingReconciliations.delete(captureId));
    pendingReconciliations.set(captureId, work);
    return work;
}

async function pollFinalizationOnce(state, auth, view = null, knownRemote) {
    try {
        await reconcileServerSessionOnce(state, auth, view, knownRemote);
    } catch (error) {
        const current = await getUploadState(view);
        if (!sameUploadAttempt(current, state) || current.state !== STATE.finalizing) return;
        if (error?.status && ![429, 500, 502, 503, 504].includes(error.status)) {
            await updateCapture(captureIdOf(state), { blocked: true });
            await setUploadState(view, {
                state: STATE.error,
                blocked: true,
                error: retryErrorMessage(error, t("finalizeFailed")),
            }, state);
        } else if (isConnectionError(error)) {
            await ensureConnectionAlarm();
        } else {
            await setUploadState(view, { uploadNotice: retryErrorMessage(error, t("finalizeFailed")) }, state);
            await ensureUploadRetryAlarm(Math.max(1, (error?.retryAfterSeconds ?? 0) / 60));
        }
    }
}

async function reconcileServerSessionOnce(owner, auth, view, knownRemote) {
    const sessionId = owner.sessionId;
    let remote = knownRemote ?? await getSession(auth, sessionId);
    let state = await getUploadState(view);
    if (!sameUploadAttempt(state, owner) || state.state === STATE.completed) return;
    if (remote.status === "completing" || remote.status === "completed") {
        const captureId = captureIdOf(state);
        captureLeases.end(captureId);
        const meta = await readLocalMeta(captureId);
        if (captureDiscards.has(captureId) || meta?.discardRequested) return;
        if (meta && (meta.cleanupPending || (!meta.completeIntent?.truncatedAtChunk && !meta.truncatedAtChunk &&
            (!Number.isInteger(meta.highestCommittedIndex) || captureHasGap(meta)) && await checkStoppedBuffer(view, state, meta, await listChunkIndices(captureId, true),
                [...(remote.received_chunks ?? []), ...(state.uploaded ?? [])]) === null))) return;
        if (meta?.completeIntent) {
            const result = await dispatchComplete(captureId, auth, sessionId, meta.completeIntent);
            if (!result) return;
            if (completeAcknowledged(result)) {
                const agendaUnavailable = result.agenda?.attached === false && result.agenda.reason === "unavailable";
                await updateCapture(captureId, { completeIntent: null, ...(agendaUnavailable ? { agendaUnavailable } : {}) });
                if (agendaUnavailable) state = await setUploadState(view, { agendaUnavailable }, state) ?? state;
            }
            if (result.status) remote = result;
        }
    }
    if (remote.status === "completing") {
        const jobId = remote.job_id ?? state.jobId ?? null;
        if (!state.serverCompleting || state.jobId !== jobId || state.uploadNotice)
            await setUploadState(view, { serverCompleting: true, jobId, uploadNotice: null }, state);
        if (view) await updateCapture(captureIdOf(state), { nextRetryAt: new Date(Date.now() + 30_000).toISOString() });
        await ensureUploadRetryAlarm();
        return;
    }
    if (remote.status === "completed") {
        if (typeof remote.recording_id !== "string" || !remote.recording_id.trim()) {
            await updateCapture(captureIdOf(state), { blocked: true });
            await setUploadState(view, {
                state: STATE.error,
                blocked: true,
                error: "Server confirmed completion without a recording ID",
            }, state);
            return;
        }
        const url = new URL("/dashboard", auth.serverUrl);
        url.searchParams.set("recording", remote.recording_id);
        const recordingUrl = url.href;
        const captureId = captureIdOf(state);
        if ((await readLocalMeta(captureId))?.discardRequested || captureDiscards.has(captureId)) return;
        const removed = await safe(removeCapture(captureId).then(() => true));
        if (!removed) await ensureUploadRetryAlarm();
        const displayed = await setUploadState(view, {
            state: STATE.completed,
            uploadNotice: null,
            recordingUrl,
            partial: Boolean(remote.truncated_at_chunk),
        }, state);
        const completionBody = remote.truncated_at_chunk ? t("partialRecordingSent") : t("recordingSentBody");
        await notify(
            t("recordingSent"),
            completionBody + (state.agendaUnavailable ? `\n${t("agendaUnavailable")}` : ""),
            { id: `${COMPLETION_PREFIX}${encodeURIComponent(recordingUrl)}` },
        );
        if (view || !displayed) return;
        await new Promise((resolve) => setTimeout(resolve, COMPLETION_DISPLAY_MS));
        const shown = await getState();
        if (shown.state !== STATE.completed || !sameUploadAttempt(shown, state)) return;
        await resetState(state, sameUploadAttempt);
        await new Promise((resolve) => setTimeout(resolve, 400));
        if ((await getState()).state === STATE.idle) {
            await navigateToRecording(auth.serverUrl, recordingUrl, state.tabId).catch(() => {});
        }
        return;
    }
    if (remote.status === "failed" || remote.status === "aborted") {
        await updateCapture(captureIdOf(state), { blocked: true });
        await setUploadState(view, {
            state: STATE.error,
            blocked: true,
            error: remote.error ?? `Server session ${remote.status}`,
        }, state);
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

async function prepareRecordingAgenda(tabId, shownAgendaId, localOnly = false) {
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
    if (!agenda && shown && !localOnly && !(await serverUnavailable(settings))) {
        const loaded = await agendaRequest(`/${encodeURIComponent(shown)}`);
        if (loaded.permissions?.edit) agenda = { ...loaded, start: loaded.plannedStart, end: loaded.plannedEnd };
    }
    if (!agenda && localOnly && shown) {
        agenda = { id: shown };
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
    const requestedState = message.captureId || message.sessionId ? getState().catch(() => null) : null;
    const update = recordingMetadataUpdates.then(async () => handleAgendaMessageNow(message, sender, await requestedState));
    recordingMetadataUpdates = update.catch(() => {});
    return update.then(async ({ saveDraft, announcement, ...response }) => {
        const saved = await saveDraft?.();
        try {
            await announcement;
        } catch (error) {
            if (!saveDraft) throw error;
            return { ...response, saved, linkError: t("agendaFailed") };
        }
        return { ...response, saved };
    });
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
    let saveDraft;
    if (edit) {
        if (!isExtensionPage(sender.url, "agenda/agenda.html") ||
            typeof message.agendaId !== "string" || !message.agendaId ||
            typeof edit.path !== "string" ||
            (edit.path !== "/text" && !/^\/(?:points|tasks)\/[^/?#]+$/.test(edit.path)) ||
            !edit.body || typeof edit.body !== "object")
            throw new Error(t("agendaFailed"));
        saveDraft = () => saveAgendaEdit(message.agendaId, edit.path, edit.body);
        const state = await getState();
        const canLink = state.agendaId
            ? state.agendaId !== message.agendaId && !state.agendaOwn
            : !state.agendaExplicit;
        if (!canLink || !wasQueuedDuringCapture(requestedState, state) ||
            !controlMatchesCapture(state, message) || message.tabId !== state.tabId) return { ok: true, saveDraft };
    }
    try {
        return { ok: true, ...await linkRecordingAgenda(message, settings, tab, requestedState), saveDraft };
    } catch (error) {
        if (!edit) throw error;
        return { ok: true, saveDraft, linkError: t("agendaFailed") };
    }
}

async function linkRecordingAgenda(message, settings, tab, requestedState) {
    let agenda = null;
    let announcement;
    if (message.agendaId != null) {
        agenda = await agendaRequest(`/${encodeURIComponent(message.agendaId)}`);
        if (!agenda.permissions?.edit) throw new Error(t("agendaFailed"));
        agenda = { ...agenda, start: agenda.plannedStart, end: agenda.plannedEnd };
    }
    const state = await getState();
    if (message.captureId || message.sessionId) {
        const metadataState = state.stopped && wasQueuedDuringCapture(requestedState, state) &&
            (state.state === STATE.recording || (state.state === STATE.error && state.blocked))
            ? { ...state, state: STATE.recording, stopped: false } : state;
        if (!controlMatchesCapture(state, message) || !canChooseRecordingAgenda(metadataState)) throw new Error(t("agendaFailed"));
        if (message.type === "edit-agenda" && (message.tabId !== state.tabId || !shouldLinkEditedAgenda(metadataState, agenda))) return { agenda };
        const patch = { agendaId: agenda?.id ?? null, agendaTitle: agenda?.title ?? null, agendaOwn: agenda?.own === true, agendaExplicit: true,
            folderId: settings.folderId, folderLabel: settings.folderLabel, folderScope: settings.folderScope,
            ...agendaFolder(agenda) };
        const captureId = captureIdOf(state);
        if (!(await updateCapture(captureId, (meta) => {
            if (meta.completeIntent) throw new Error(t("agendaFailed"));
            const { agendaTitle: _agendaTitle, ...durable } = patch;
            return durable;
        }, async () => sameUploadOwner(await getState(), state))) ||
            !(await setState(patch, state))) throw new Error(t("agendaFailed"));
        if (settings.serverDefaults?.sessionAgenda === true && state.sessionId && !state.stopped) {
            announcement = recordingAgendaAnnouncements.then(async () => {
                const current = await getState();
                if (!sameUploadOwner(current, state) || current.stopped || current.agendaId !== patch.agendaId) return;
                const meta = await readLocalMeta(captureId);
                await setSessionAgenda(await captureAuth(captureId, meta, settings), state.sessionId, patch.agendaId);
            });
            recordingAgendaAnnouncements = announcement.catch(() => {});
        }
    } else {
        const target = JSON.stringify(meetingTarget(tab?.url));
        await chrome.storage.session.set({ [AGENDA_SELECTION_KEY]: { serverUrl: settings.serverUrl, connectionId: settings.connectionId, target, at: Date.now(), agenda, explicit: true } });
    }
    if (message.type === "select-agenda" && tab) {
        const binding = await joinedMeeting(tab, settings);
        if (binding) await chrome.storage.session.set({ [`meeting-tab:${tab.id}`]: { ...binding, agendaId: agenda?.id ?? null } });
    }
    return { agenda, announcement };
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
    const startPath = getSettings().then(recordingStartPath).catch(() => null);
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
        startPath: await startPath,
    }, false, tab);
}

const MEETING_BANNER_MESSAGES = new Set(["meeting-banner-ready", "meeting-banner-dismiss"]);
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
    if (payload.view === "waiting") void promptIcon.pause(tabId);
    else if (payload.view !== "prompt") stopPromptIcon(tabId);
    if (payload.view !== "recording") disconnectMeetingLevels(tabId);
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

const meetingLevelPorts = new Map();

function canStreamMeetingLevels(state) {
    return isLiveCapture(state) && !state.captureStopping;
}

function disconnectMeetingLevels(tabId) {
    for (const [port, client] of meetingLevelPorts) {
        if (client.tabId !== tabId) continue;
        meetingLevelPorts.delete(port);
        port.disconnect();
    }
}

chrome.runtime.onConnect?.addListener((port) => {
    if (port.name !== "meeting-levels") return;
    const { sender } = port;
    const client = { tabId: sender?.tab?.id, captureId: null, sentAt: -Infinity };
    meetingLevelPorts.set(port, client);
    port.onDisconnect.addListener(() => meetingLevelPorts.delete(port));
    void (async () => {
        const state = await getState();
        if (!sender || !canStreamMeetingLevels(state) || state.tabId !== client.tabId ||
            !state.meetingTarget || !sameMeetingTarget(state.meetingTarget, sender.url) ||
            !(await validMeetingBannerSender(sender, state))) return;
        const latest = await getState();
        if (sameCapture(latest, state) && canStreamMeetingLevels(latest)) client.captureId = captureIdOf(state);
    })().finally(() => {
        if (!client.captureId && meetingLevelPorts.delete(port)) port.disconnect();
    }).catch(() => {});
});

function validLevelBands(bands) {
    return Array.isArray(bands) && bands.length === 4 && bands.every(Number.isFinite);
}

function publishMeetingLevels(state, { micBands, systemBands }) {
    const { micDb, systemDb } = state.levels;
    const levels = {
        micDb,
        systemDb,
        ...(validLevelBands(micBands) ? { micBands } : {}),
        ...(validLevelBands(systemBands) ? { systemBands } : {}),
    };
    const now = Date.now();
    for (const [port, client] of meetingLevelPorts) {
        if (client.tabId !== state.tabId || client.captureId !== captureIdOf(state) || now - client.sentAt < 125) continue;
        try {
            port.postMessage(levels);
            client.sentAt = now;
        } catch {
            meetingLevelPorts.delete(port);
        }
    }
}

async function dismissMeetingBanner(tabId) {
    const entry = await updateArmedTab(tabId, (current) => current ? {
        ...current, nudged: true, dismissed: true, bannerPrompt: false, promptVisible: false, consentShown: false, notificationFallback: false,
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
    const disconnected = Boolean(connection && connection.state !== "ok");
    const canRecordOffline = Boolean(sealedRecipient(settings));
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
    if (enabled && ownRecording && state.state !== STATE.idle &&
        !(state.startConnectionError && (!disconnected || entry?.bannerPrompt))) {
        if (state.sessionId || (state.protocol === 2 && state.state === STATE.recording && captureIdOf(state)) ||
            (state.state === STATE.error && !state.startConnectionError)) {
            await updateArmedTab(tabId, (current) => current ? {
                ...current, bannerPrompt: false, promptVisible: false, consentShown: false, nudged: true, dismissed: true,
            } : null);
        }
        const recording = isLiveCapture(state) && state.state !== STATE.awaitingPicker;
        const view = recording ? "recording" : state.state === STATE.error ? "error" :
            state.state === STATE.awaitingPicker ? "waiting" : "stopped";
        if (view === "error" && (entry?.errorDismissed || state.meetingBannerErrorDismissed)) {
            await sendMeetingBanner(tabId, { view: "hidden" });
        } else await sendMeetingBanner(tabId, { view,
            connection: connectionNotice(connection, { recording, sealed: state.protocol === 2, stopped: state.stopped, starting: state.startConnectionError || state.connecting }),
            state: {
            state: state.state,
            sessionId: state.sessionId,
            captureId: captureIdOf(state),
            startedAt: state.startedAt,
            stopped: state.stopped,
            captureStopping: state.captureStopping,
            connecting: state.connecting,
            offline: recording && disconnected,
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
    if (enabled && settings.nudgeEnabled && entry?.bannerPrompt && !hasAcknowledgedAuto(entry.mode, settings) &&
        sameMeetingTarget(entry.meetingTarget, tab.url)) {
        const pinAtLookup = pinGeneration;
        const isCurrentPrompt = () => isCurrent() && pinAtLookup === pinGeneration;
        const [commands, actionSettings] = await Promise.all([
            chrome.commands.getAll().catch(() => []),
            chrome.action.getUserSettings().catch(() => ({})),
        ]);
        if (!isCurrentPrompt()) return;
        const pinned = actionSettings.isOnToolbar !== false;
        if ((disconnected && !canRecordOffline) || !pinned) void promptIcon.pause(tabId);
        const blink = pinned && (!disconnected || canRecordOffline) ? await promptIcon.reserve(tabId, isCurrentPrompt) : null;
        if (!isCurrentPrompt()) return;
        const shortcut = commands.find((command) => command.name === "toggle-recording")?.shortcut || "";
        if (entry.consentShown && ((disconnected && !canRecordOffline) || agendaRoute || !shortcut || entry.mode !== "prompt")) {
            await updateArmedTab(tabId, (current) => current && isCurrentPrompt() ? { ...current, consentShown: false } : current);
        }
        if (!isCurrentPrompt()) return;
        const response = await sendMeetingBanner(tabId, {
            view: "prompt",
            connection: connectionNotice(connection, { sealed: canRecordOffline }),
            disconnected: disconnected && !canRecordOffline,
            agendas,
            agendaPanel: agendaRoute,
            notice: effectiveNoticeText(settings),
            shortcut,
            pinned,
            blinkUntil: blink?.until ?? null,
            policyRequired: entry.mode === "auto" && !settings.autoModeAcknowledgedAt,
        }, isCurrentPrompt);
        if (!isCurrentPrompt()) return;
        const next = await updateArmedTab(tabId, (current) => current && isCurrentPrompt() ? {
            ...current,
            promptVisible: current.bannerPrompt === true && response?.visible === true,
            consentShown: current.bannerPrompt === true && response?.visible === true && (!disconnected || canRecordOffline) &&
                !agendaRoute && Boolean(shortcut) && current.mode === "prompt" && response?.consentShown === true,
            shownAgendaId: response?.visible === true && agendas.length === 1 ? agendas[0].id : undefined,
            notificationFallback: response?.visible === true ? false : current.notificationFallback,
        } : current);
        if (!isCurrentPrompt()) return;
        await applyArmedUi(tabId, platformById(entry.platformId), entry.mode);
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
        await updateArmedTab(tabId, (current) => current ? { ...current, promptVisible: false, bannerPrompt: false, consentShown: false } : null);
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
        if (state.tabId !== tabId || !controlMatchesCapture(state, message)) throw new Error(t("unrecognizedSender"));
        return stopRecording("user", { ...message, tabId, captureId: captureIdOf(state) });
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
    return { ok: true };
}

async function reconcileMeetingPromptAndTabs() {
    const enabled = await reconcileMeetingPrompt();
    const armed = await getArmed();
    for (const id of Object.keys(armed)) {
        const tabId = Number(id);
        await updateArmedTab(tabId, (entry) => entry ? {
            ...entry, bannerPrompt: false, promptVisible: false, consentShown: false, nudged: entry.dismissed === true,
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

async function applyArmedUi(tabId, platform, mode) {
    // In auto mode the popup is disabled on this tab, so the toolbar click is
    // a direct invocation that unlocks tab capture.
    await safe(
        chrome.action.setPopup({
            tabId,
            popup: agendaTabs.has(tabId) || mode === "auto" ? "" : POPUP_URL,
        }),
    );
    await restorePromptBadge(tabId, () => !promptIcon.isBlinking(tabId));
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
            consentShown: same && existing.mode === mode && existing.consentShown === true,
            notificationFallback: same && existing.notificationFallback === true,
            errorDismissed: same && existing.errorDismissed === true,
            bannerError: same ? existing.bannerError ?? null : null,
            shownAgendaId: same ? existing.shownAgendaId : undefined,
        };
    });
    await applyArmedUi(tab.id, platform, mode);
    const fresh = await chrome.tabs.get(tab.id).catch(() => null);
    if (fresh?.audible && !entry.nudged) await nudge(tab.id, platform);
    else await syncMeetingBanner(tab.id);
}

async function disarm(tabId, isCurrent = () => true) {
    if (!(await getArmed())[tabId]) return;
    await updateArmedTab(tabId, () => null);
    await sendMeetingBanner(tabId, { view: "hidden" });
    await chrome.notifications.clear(`${NUDGE_PREFIX}${tabId}`).catch(() => {});
    await safe(chrome.action.setPopup({ tabId, popup: agendaTabs.has(tabId) ? "" : POPUP_URL }));
    await queueTabBadge(tabId, () => EMPTY_BADGE, isCurrent);
    if (await isCurrent()) await safe(chrome.action.setTitle({ tabId, title: DEFAULT_TITLE }));
}

function hasAcknowledgedAuto(mode, settings) {
    return mode === "auto" && Boolean(settings.autoModeAcknowledgedAt);
}

async function nudge(tabId, platform) {
    const settings = await getSettings();
    if (!settings.nudgeEnabled) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.audible || detectMeetingPlatform(tab.url)?.id !== platform.id) return;
    const banner = isPromptMeeting(tab.url) && await hasMeetingPromptAccess();
    let shouldNudge = false;
    const entry = await updateArmedTab(tabId, (entry) => {
        if (!entry || entry.nudged) return entry;
        shouldNudge = true;
        return { ...entry, nudged: true, bannerPrompt: banner && !hasAcknowledgedAuto(entry.mode, settings), promptVisible: false, consentShown: false };
    });
    if (!shouldNudge) return;
    if (entry?.bannerPrompt) {
        await injectMeetingPrompt(tabId).catch(() => {});
        await syncMeetingBanner(tabId);
        return;
    }
    await notifyMeetingNudge(tabId, platform, settings);
}

async function notifyMeetingNudge(tabId, platform, settings) {
    const entry = await updateArmedTab(tabId, (entry) => entry ? {
        ...entry, notificationFallback: true,
    } : entry);
    const nextMeeting = (await cachedNextMeeting())?.data;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (settings.meetingNotifications && nextMeeting && Date.parse(nextMeeting.end) > Date.now() &&
        meetingRoom(nextMeeting.joinUrl) === meetingRoom(tab?.url)) return;
    const access = await hasMeetingPromptAccess();
    const body = entry?.mode === "auto"
        ? (settings.autoModeAcknowledgedAt ? "meetingRecordAutoBody" : "meetingRecordPolicyBody")
        : "meetingRecordBody";
    await notify(
        t("meetingPromptTitle", t("appName")),
        t(body, [platform.name, t("recordTabWithConsent")]) +
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
    const recording = state.tabId === tab.id && hasRecordingBadge(state);

    if (recording) {
        if (!platform && state.state === STATE.recording &&
            state.autoStarted
        )
            await stopRecording("meeting-ended", { captureId: captureIdOf(state) });
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
    const tabUnclaimed = async () => {
        const current = await getState();
        return current.tabId !== tab.id || !hasRecordingBadge(current);
    };
    await disarm(tab.id, tabUnclaimed);
    const micMissing = settings.dataUseAcknowledgedAt && !settings.micReminderDismissed &&
        (await microphonePermission()) !== "granted";
    await queueTabBadge(tab.id, () => micMissing ? MIC_BADGE : EMPTY_BADGE, tabUnclaimed);
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
    if (changeInfo.url || changeInfo.status === "loading") {
        roomRecorderLookup.invalidate(tabId);
        stopPromptIcon(tabId, true);
        disconnectMeetingLevels(tabId);
        await updateArmedTab(tabId, (entry) => entry?.consentShown ? { ...entry, consentShown: false } : entry);
    }
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
    roomRecorderLookup.invalidate(tabId);
    disconnectMeetingLevels(tabId);
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
        await stopRecording("tab-closed", { tabId, captureId: captureIdOf(state) });
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
    if (roomPairingChanged(changes)) roomRecorderLookup.invalidatePairing();
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
    if (changes.encryptedApiKey?.newValue ||
        changes.serverDefaults?.newValue?.accountId !== changes.serverDefaults?.oldValue?.accountId ||
        (changes.serverDefaults?.newValue?.offlineRecording && !changes.serverDefaults?.oldValue?.offlineRecording)) {
        void reconcileBufferedRecordings().catch(() => {});
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
async function startFromInvocation(tab, startPath) {
    const state = await getState();
    if ((state.state === STATE.recording || isLiveCapture(state)) && !state.stopped && state.tabId === tab.id) {
        await stopRecording("user", { captureId: captureIdOf(state) });
        return;
    }
    if (
        state.state === STATE.awaitingPicker ||
        (state.state === STATE.recording || state.state === STATE.finalizing) && !(state.stopped && state.protocol === 2)
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
    const shortcutConsent = entry?.mode === "prompt" && entry.consentShown === true &&
        sameMeetingTarget(entry.meetingTarget, tab.url) && await hasMeetingPromptAccess();
    const autoConsent = settings.autoModeAcknowledgedAt;
    if (!shortcutConsent && !autoConsent) {
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
            noticeAcknowledgedAt: autoConsent || new Date().toISOString(),
            startPath: await startPath,
        }, false, tab);
    } catch (error) {
        if (entry?.promptVisible && entry.bannerPrompt) await showMeetingBannerError(tab.id, tab.url, error);
        await notify(t("couldNotStart"), error?.message ?? String(error));
    }
}

async function handleToolbarClick(tab, startPath) {
    const entry = (await getArmed())[tab.id];
    if (entry?.mode === "auto") await startFromInvocation(tab, startPath);
    else if (entry?.mode === "prompt" && chrome.action.openPopup) {
        await chrome.action.setPopup({ tabId: tab.id, popup: POPUP_URL });
        await chrome.action.openPopup({ windowId: tab.windowId });
    }
}

chrome.action.onClicked.addListener((tab) => {
    const startPath = getSettings().then(recordingStartPath).catch(() => null);
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
                await handleToolbarClick(tab, startPath);
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
    void handleToolbarClick(tab, startPath).catch(() => {});
});

chrome.commands.onCommand.addListener(async (command) => {
    if (command !== "toggle-recording") return;
    const startPath = getSettings().then(recordingStartPath).catch(() => null);
    const state = await getState();
    if (isLiveCapture(state)) {
        await stopRecording("user", { captureId: captureIdOf(state) });
        return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await startFromInvocation(tab, startPath);
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
        if ((await getState()).captureStopping) await resumeCaptureOnWake();
        if (await serverUnavailable()) await ensureConnectionAlarm();
        else await reconcileBufferedRecordings();
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
        if (!(await stopRecording("auto-quiet", { tabId, captureId: captureIdOf(state) })).ok) return;
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
    if (starting) return { ok: false, error: t("alreadyInProgress") };
    starting = true;
    startCancelled = false;
    return startCapturedRecording({
        tabId: state.tabId,
        target: state.meetingTarget,
        platformHint: state.platformHint,
        auto: state.autoStarted,
        noticeAcknowledgedAt: state.noticeAcknowledgedAt,
        withoutMicrophone: state.withoutMicrophone,
        captureMode: "desktop",
        captureWindowId: state.captureWindowId,
        pickerRequestId: state.pickerRequestId,
        startPath: state.startPath,
    }).then((result) => ({ ok: true, ...(result.cancelled ? { cancelled: true } : {}) })).finally(releaseStart);
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
    const tab = await requireStartTab(request.input.tabId, meetingTarget(request.tabUrl));
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
        tab,
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
        case "room-recorders":
            if (sender.id !== chrome.runtime.id ||
                ![POPUP_URL, "agenda/agenda.html"].some((path) => isExtensionPage(sender.url, path)) ||
                !Number.isInteger(message.tabId)) {
                sendResponse({});
                return false;
            }
            roomRecorderLookup.get(message.tabId).then(sendResponse, () => sendResponse({}));
            return true;
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
            resumeCaptureOnWake().catch(() => {})
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
            stopRecording(message.reason ?? "user", message.captureId ? { ...message, tabId: undefined } : null)
                .then(sendResponse)
                .catch((error) =>
                    sendResponse({ ok: false, error: error?.message ?? String(error) }),
                );
            return true;

        case "retry-upload":
            retryUpload(message.captureId)
                .then(() => sendResponse({ ok: true }))
                .catch((error) =>
                    sendResponse({ ok: false, error: error?.message ?? String(error) }),
                );
            return true;

        case "dismiss-pending-capture":
            if (sender.id !== chrome.runtime.id ||
                ![POPUP_URL, "agenda/agenda.html"].some((path) => isExtensionPage(sender.url, path))) {
                sendResponse({ ok: false });
                return false;
            }
            getState().then(async (state) => {
                if (state.protocol === 2 && state.stopped && message.captureId === captureIdOf(state)) {
                    await setState(IDLE_STATE, state);
                    void reconcileBufferedRecordings().catch(() => {});
                }
                return { ok: true };
            }).then(sendResponse, () => sendResponse({ ok: false }));
            return true;

        case "check-finalization":
            getState()
                .then(async (state) => {
                    if (message.captureId && message.captureId !== captureIdOf(state)) return;
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
            savePlayablePrefix(message.chunkCount, message.captureId)
                .then(() => sendResponse({ ok: true }))
                .catch((error) => sendResponse({ ok: false, error: error?.message ?? String(error) }));
            return true;

        case "discard-session":
            getState().then(async (state) => {
                if (!controlMatchesCapture(state, message)) {
                    if (typeof message.captureId === "string" && /^[\w-]+$/.test(message.captureId) &&
                        !(await readLocalMeta(message.captureId))) return;
                    throw new Error(t("recoveryUnavailable"));
                }
                if (captureIdOf(state)) await discardBuffer(captureIdOf(state));
                else await resetState(state);
            })
                .then(() => sendResponse({ ok: true }))
                .catch((error) =>
                    sendResponse({ ok: false, error: error?.message ?? String(error) }),
                );
            return true;

        case "retry-buffer":
        case "save-buffer-prefix":
        case "discard-buffer":
            if (sender.id !== chrome.runtime.id || !isExtensionPage(sender.url, "options/options.html") ||
                typeof message.bufferId !== "string" || !/^[\w-]+$/.test(message.bufferId)) {
                sendResponse({ ok: false, error: t("unrecognizedSender") });
                return false;
            }
            (message.type === "retry-buffer" ? retryBuffer(message.bufferId) : message.type === "save-buffer-prefix"
                ? savePendingPlayablePrefix(message.bufferId) : discardBuffer(message.bufferId))
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

        case "chunk-ready":
        case "recording-started":
        case "levels":
        case "recording-stopped":
        case "mic-unavailable":
        case "stream-ended":
        case "capture-error":
            void handleCaptureEvent(message, sender).catch(() => {});
            return false;

        default:
            return false;
    }
});

async function handleCaptureEvent(message, sender) {
    const state = await getState();
    if (!messageMatchesCapture(state, message) || state.stopped) return;
    const captureId = captureIdOf(state);
    if (message.captureId || message.type === "levels") {
        const path = state.captureMode === "desktop" ? "picker/picker.html" : OFFSCREEN_URL;
        if (sender.id !== chrome.runtime.id || !isExtensionPage(sender.url, path)) return;
        if (state.captureMode === "desktop" &&
            (new URL(sender.url).searchParams.get("requestId") !== state.pickerRequestId ||
                (sender.tab && sender.tab.windowId !== state.captureWindowId))) return;
    }
    switch (message.type) {
        case "levels":
            if (!canStreamMeetingLevels(state)) return;
            publishMeetingLevels({ ...state, levels: { micDb: message.micDb, systemDb: message.systemDb } }, message);
            await setState({ levels: { micDb: message.micDb, systemDb: message.systemDb } }, state);
            return;
        case "chunk-ready": {
            if (Number.isSafeInteger(message.index) && message.index >= 0) {
                await confirmCaptureChunk(captureId, message.index);
                if (state.protocol === 2 && Number.isSafeInteger(message.bytes)) {
                    await updateCapture(captureId, (meta) => ({
                        bufferedBytes: Math.max(meta.bufferedBytes ?? 0, message.bytes),
                    }));
                    await setState({
                        storedParts: Math.max((await getState()).storedParts ?? 0, message.index + 1),
                        bufferedBytes: Math.max((await getState()).bufferedBytes ?? 0, message.bytes),
                    }, state);
                }
            }
            break;
        }
        case "recording-started":
            if (state.protocol === 2 && !starting) void reconcileBufferedRecordings().catch(() => {});
            return;
        case "recording-stopped":
            await handleRecordingStopped(message, state);
            return;
        case "mic-unavailable":
            await handleMicrophoneFailure(message);
            return;
        case "stream-ended":
            await stopRecording("stream-ended", { captureId });
            return;
        case "capture-error":
            await withCapture(captureId, async () => {
                const current = await getState();
                if (!sameCapture(current, state) || current.stopped) return;
                if (state.protocol === 2) {
                    await updateCapture(captureId, { interrupted: true });
                    await setState({ uploadNotice: t("recordingBufferInterrupted") }, state);
                } else {
                    await updateCapture(captureId, { blocked: true });
                    await setState({ state: STATE.error, blocked: true, error: message.message }, state);
                }
                await requestCaptureStop(await getState(), "error");
            });
            return;
    }
    await (state.captureId && !starting ? reconcileBufferedRecordings() : pumpUploads());
}

async function handleMicrophoneFailure(message) {
    const state = await getState();
    if (!messageMatchesCapture(state, message) || state.state !== STATE.recording) return;
    const warning = t("micUnavailableBody", microphoneError(message.errorName));
    await setState({ micWarning: warning }, state);
    await notify(t("micUnavailable"), warning, {
        id: `mic:${captureIdOf(state)}`,
        requireInteraction: true,
    });
}

async function handleRecordingStopped(message, owner) {
    owner ??= await getState();
    captureLeases.end(captureIdOf(owner));
    await withCapture(captureIdOf(owner), () => recordCaptureStopped(message, owner));
    await (owner.captureId && !starting ? reconcileBufferedRecordings() : pumpUploads());
}

async function recordCaptureStopped(message, owner) {
    const state = await getState();
    if (!sameCapture(state, owner) || state.stopped) return;
    const captureId = captureIdOf(state);
    const meta = await markStopped(captureId, {
        stoppedAt: message.stoppedAt,
        stopReason: state.stopReason,
        chunkCount: message.chunkCount ?? 0,
        uploaded: state.uploaded,
    }).catch(async (error) => {
        await setState({
            state: STATE.error, stopped: true, captureStopping: false,
            blocked: true, chunkCount: message.chunkCount ?? 0,
            error: error.message,
        }, state);
        return null;
    });
    if (state.captureMode !== "desktop") await closeOffscreen();
    if (!meta) return;
    if (!meta.chunkCount && !meta.refusal) {
        await cleanEmptyCapture(state);
        if (state.captureMode === "desktop" && state.captureWindowId != null) {
            await chrome.windows.remove(state.captureWindowId).catch(() => {});
        }
        await notify(t("nothingRecorded"), t("nothingRecordedBody"));
        return;
    }
    if (message.limitReached || meta.limitReached) await notify(t("recordingStopped"), t("recordingLimitReached"));
    else if (meta.protocol === 2 && (message.interrupted || meta.interrupted)) {
        await notify(t("recordingStopped"), t("recordingBufferInterrupted"));
    }
    const prefix = meta.verifiedPrefix + 1;
    await setState({
        stopped: true, captureStopping: false,
        chunkCount: meta.chunkCount,
        ...(message.limitReached || meta.limitReached ? { uploadNotice: t("recordingLimitReached") } : {}),
        ...(state.blocked ? { state: STATE.error, error: state.error ?? state.uploadNotice, uploadNotice: null } : {}),
        recoverablePrefix: state.recoverablePrefix ?? (prefix > 0 && prefix < meta.chunkCount ? prefix : null),
    }, state);
    if (state.captureMode === "desktop" && state.captureWindowId != null) {
        await chrome.windows.update(state.captureWindowId, { state: "normal", focused: true }).catch(() => {});
    }
}

async function cleanEmptyCapture(state) {
    const captureId = captureIdOf(state);
    const meta = await readLocalMeta(captureId);
    if (meta?.protocol === 2) return discardCapture(captureId);
    if (meta && !meta.createIntent && serverSessionFor(meta, captureId) === null) {
        await removeCapture(captureId);
        await resetState(state);
        return;
    }
    await updateCapture(captureId, { discardRequested: true });
    const settings = await getSettings();
    try {
        await cleanFailedStart(captureId, await captureAuth(captureId, meta, settings, { forLookup: true }));
    } catch {
        await ensureUploadRetryAlarm();
        await resetState(state);
    }
}

async function sealMissingHost(owner, reason = "browser-closed", { report = true } = {}) {
    const state = await getState();
    if (!sameCapture(state, owner) || !isLiveCapture(state)) return;
    const captureId = captureIdOf(state);
    captureLeases.end(captureId);
    const previous = await readLocalMeta(captureId);
    const stopReason = previous?.stopReason ?? reason;
    const meta = await markStopped(captureId, { stopReason, uploaded: state.uploaded }).catch(() => null);
    if (!meta) {
        await setState({
            state: STATE.error, stopped: true, captureStopping: false, connecting: false, blocked: true,
            stopReason, error: t("recoveryUnavailable"),
        }, state);
        return;
    }
    await setState({
        stopped: true, captureStopping: false, connecting: false, captureWindowId: null,
        stopReason: meta.stopReason, chunkCount: meta.chunkCount,
        state: meta.chunkCount ? STATE.recording : STATE.error,
    }, state);
    if (report && !previous?.stoppedAt) {
        await notify(t("recordingStopped"), t(meta.chunkCount ? "meetingPromptStopped" : "nothingRecordedBody"));
    }
    if (!meta.chunkCount && !meta.refusal) await cleanEmptyCapture(state);
}

let captureWake;
function resumeCaptureOnWake() {
    captureWake ??= reconcileCaptureHost().finally(() => { captureWake = null; });
    return captureWake;
}

async function reconcileCaptureHost() {
    const state = await getState();
    if (!isLiveCapture(state)) return reconcileDesktopWindow();
    if (starting) return;
    const captureId = captureIdOf(state);
    await withCapture(captureId, async () => {
        if (!sameCapture(await getState(), state)) return;
        const meta = await readLocalMeta(captureId);
        if (!meta?.captureId) return;
        const host = await messageCaptureHost(state, "ping").catch(() => null);
        if (host?.captureId === captureId) {
            if (!state.captureStopping && !meta.stopRequestedAt) return;
            captureLeases.end(captureId);
            await setState({ captureStopping: true, stopReason: meta.stopReason ?? state.stopReason }, state);
            const response = await messageCaptureHost(state, "stop").catch(() => null);
            if (response?.ok) return;
            const currentHost = await messageCaptureHost(state, "ping").catch(() => null);
            if (currentHost?.captureId === captureId) {
                await ensureUploadRetryAlarm();
                return;
            }
        }
        await sealMissingHost(state);
    });
}

async function savePlayablePrefix(chunkCount, captureId) {
    const state = await getState();
    if (captureId && captureId !== captureIdOf(state)) throw new Error(t("recoveryUnavailable"));
    return transitionBuffer(async () => {
        await withCapture(captureIdOf(state), () => savePlayablePrefixOnce(chunkCount, state));
        await pumpUploadsOnce();
    });
}

async function savePlayablePrefixOnce(chunkCount, expected) {
    const state = await getState();
    if (
        !sameCapture(state, expected) ||
        !state.stopped ||
        !state.sessionId ||
        !Number.isInteger(chunkCount) ||
        chunkCount < 1 ||
        chunkCount >= state.chunkCount ||
        chunkCount !== state.recoverablePrefix
    ) {
        throw new Error("No verified playable prefix is available");
    }
    if ((await readLocalMeta(captureIdOf(state)))?.completeIntent) throw new Error(t("recoveryUnavailable"));
    await updateLocalMeta(captureIdOf(state), { truncatedAtChunk: chunkCount, blocked: false, retryAttempt: 0, nextRetryAt: null });
    await setUploadState(null, { blocked: false, truncatedAtChunk: chunkCount }, state);
}

async function savePendingPlayablePrefix(captureId) {
    await transitionBuffer(() => withCapture(captureId, async () => {
        const state = await assertBufferRetryAllowed(captureId);
        const meta = await readLocalMeta(captureId);
        const settings = await getSettings();
        if (!meta || !capturePairingMatches(meta, settings) || !settings.hasApiKey ||
            !captureHasGap(meta) || meta.verifiedPrefix < 0) throw new Error(t("recoveryUnavailable"));
        const truncatedAtChunk = meta.verifiedPrefix + 1;
        await updateCapture(captureId, { truncatedAtChunk, completeIntent: null, blocked: false, retryAttempt: 0, nextRetryAt: null });
        if (captureIdOf(state) === captureId) {
            await setUploadState(null, { blocked: false, truncatedAtChunk, error: null, reconcilePending: true }, state);
        }
        await publishPendingChange();
    }));
    void reconcileBufferedRecordings().catch(() => {});
}

async function retryUpload(requestedId) {
    const captureId = captureIdOf(await getState());
    if (requestedId && captureId !== requestedId) throw new Error(t("recoveryUnavailable"));
    if (captureId) return transitionBuffer(() => withCapture(captureId, () => retryUploadOnce(captureId)));
}

async function retryUploadOnce(captureId) {
    const state = await getState();
    if (captureIdOf(state) !== captureId) return;
    if (isLiveCapture(state)) throw new Error(t("retryBufferCaptureLive"));
    const settings = await getSettings();
    const meta = await readLocalMeta(captureId);
    if (meta?.cleanupPending) throw new Error(t("recoveryUnavailable"));
    if (meta?.discardRequested && completeMayHaveDispatched(meta)) throw new Error(t("discardUnconfirmed"));
    const auth = await captureAuth(captureId, meta, settings, { forLookup: true });
    if (meta.protocol === 2 && !meta.serverSessionId) {
        await resetSealedRetry(captureId, state);
        return;
    }
    const sessionId = await reconcileCreate(captureId, meta, auth);
    if (!sessionId) throw new Error(t("recoveryUnavailable"));
    let remote = await getSession(auth, sessionId);
    await confirmCapturePairing(captureId, meta, settings);
    if (!sameUploadAttempt(await getState(), state)) throw new Error(t("retryBufferBusy"));
    if (remote.status === "completed" || remote.status === "completing") {
        const attempt = await setUploadState(null, {
            state: STATE.finalizing,
            sessionId: remote.id ?? sessionId,
            jobId: remote.job_id ?? null,
            serverCompleting: true,
            ...newFinalizationAttempt(),
            error: null,
            uploadNotice: null,
            blocked: false,
        }, state);
        if (attempt) await pollFinalizationOnce(attempt, auth);
        return;
    }
    if (remote.status === "aborted" || remote.status === "failed") {
        remote = await recoverCaptureSession(auth, sessionId, meta, settings);
        await attachSession(captureId, remote.id);
    }
    if (remote.status !== "open") throw new Error("Recording cannot be retried");
    if (!sameUploadAttempt(await getState(), state)) throw new Error(t("retryBufferBusy"));
    await setUploadState(null, {
        bufferId: captureIdOf(state),
        sessionId: remote.id ?? sessionId,
        uploaded: remote.received_chunks ?? [],
        blocked: false,
        reconcilePending: false,
        recoverablePrefix: null,
        state: STATE.error,
        jobId: null,
        serverCompleting: false,
        error: null,
        uploadNotice: null,
        finalizingAt: null,
        finalizationAttempt: null,
    }, state);
    await updateCapture(captureId, { retryAttempt: 0, nextRetryAt: null, blocked: false, refusal: null });
    await pumpUploads();
}

function retryErrorMessage(error, fallback = t("recoveryUnavailable")) {
    if (error?.code === "ACCESS_UNVERIFIABLE") return t("accessUnverifiable");
    if (error?.status === 404) return t("recordingKeyExpired");
    return accessErrorMessage(error) ?? error?.message ?? fallback;
}

let bufferTransitionCount = 0;

function transitionBuffer(change) {
    if (starting) return Promise.reject(new Error(t("retryBufferCaptureLive")));
    bufferTransitionCount++;
    const work = useUploadSlot(change).finally(() => {
        bufferTransitionCount--;
        if (!bufferTransitionCount && pumpRequested) void pumpUploads();
    });
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
    if (captureIdOf(state) !== bufferId && state.sessionId &&
        ([STATE.recording, STATE.finalizing].includes(state.state) || uploadPump || finalizations.size)) {
        throw new Error(t("retryBufferBusy"));
    }
    return state;
}

async function retryBuffer(bufferId) {
    await transitionBuffer(() => withCapture(bufferId, () => retryBufferOnce(bufferId)));
    const latest = await getState();
    if (captureIdOf(latest) === bufferId && (latest.error || latest.uploadNotice)) {
        throw new Error(latest.error || latest.uploadNotice);
    }
}

async function resetSealedRetry(captureId, state) {
    await updateCapture(captureId, { blocked: false, refusal: null, retryAttempt: 0, nextRetryAt: null });
    if (captureIdOf(state) === captureId) {
        await setUploadState(null, { blocked: false, error: null, uploadNotice: null, state: STATE.recording }, state);
    }
    void probeConnection().catch(() => {}).finally(() => void reconcileBufferedRecordings().catch(() => {}));
}

async function retryBufferOnce(bufferId) {
    await assertBufferRetryAllowed(bufferId);
    const meta = await readLocalMeta(bufferId);
    if (!meta || meta.cleanupPending) throw new Error(t("recoveryUnavailable"));
    if (meta.discardRequested && completeMayHaveDispatched(meta)) throw new Error(t("discardUnconfirmed"));
    const settings = await getSettings();
    if (!settings.dataUseAcknowledgedAt) throw new Error(t("dataUseRequired"));
    if (!capturePairingMatches(meta, settings) || !settings.hasApiKey) throw new Error(t("connectFirst"));
    const state = await assertBufferRetryAllowed(bufferId);
    if (meta.protocol === 2 && !meta.serverSessionId) return resetSealedRetry(bufferId, state);
    if (captureIdOf(state) === bufferId) {
        if (state.state === STATE.completed || state.state === STATE.idle) return;
        await retryUploadOnce(bufferId);
        await healStoppedUpload();
    } else {
        const auth = await captureAuth(bufferId, meta, settings, { forLookup: true });
        const sessionId = await reconcileCreate(bufferId, meta, auth);
        if (!sessionId) throw new Error(t("recoveryUnavailable"));
        let remote = await getSession(auth, sessionId);
        await confirmCapturePairing(bufferId, meta, settings);
        await assertBufferRetryAllowed(bufferId);
        if (remote.status === "aborted" || remote.status === "failed") {
            remote = await recoverCaptureSession(auth, sessionId, meta, settings);
            await attachSession(bufferId, remote.id);
        }
        const serverSessionId = remote.id ?? sessionId;
        if (remote.status === "completed" || remote.status === "completing") {
            const owner = await assertBufferRetryAllowed(bufferId);
            const attempt = await setRetriedBufferState(bufferId, meta, {
                ...IDLE_STATE,
                ...recordingFolderState(meta),
                state: STATE.finalizing,
                protocol: meta.protocol ?? 1,
                captureId: meta.captureId ?? null,
                reconcilePending: false,
                stopped: true,
                sessionId: serverSessionId,
                bufferId,
                jobId: remote.job_id ?? null,
                serverCompleting: true,
                ...newFinalizationAttempt(),
            }, owner);
            await pollFinalizationOnce(attempt, auth);
        } else if (remote.status === "open") {
            const next = await bufferedUploadState(bufferId, meta, remote);
            if (!next) throw new Error(t("recoveryUnavailable"));
            const owner = await assertBufferRetryAllowed(bufferId);
            await updateLocalMeta(bufferId, { retryAttempt: 0, nextRetryAt: null, blocked: false, refusal: null });
            await setRetriedBufferState(bufferId, meta, next, owner);
            await pumpUploads();
        } else {
            throw new Error(t("recoveryUnavailable"));
        }
    }
}

async function setRetriedBufferState(captureId, meta, patch, owner) {
    const claimed = await setState(patch, owner, (current, expected) =>
        sameUploadAttempt(current, expected) && !captureDiscards.has(captureId), async () => {
        const local = await readLocalMeta(captureId);
        return local && local.captureId === meta.captureId && !local.cleanupPending && !local.discardRequested;
    });
    if (!claimed) throw new Error(t("recoveryUnavailable"));
    return claimed;
}

function pairingFor(settings) {
    return {
        serverOrigin: originOf(settings.serverUrl),
        accountId: settings.serverDefaults?.accountId ?? null,
        connectionId: settings.connectionId,
    };
}

async function recorderAuth(settings) {
    const apiKey = await readToken();
    if (!apiKey || !sameConnection(settings, await getSettings())) throw new Error(t("connectFirst"));
    return { serverUrl: settings.serverUrl, connectionId: settings.connectionId, apiKey };
}

function capturePairingMatches(meta, settings) {
    if (!meta.pairing) return meta.serverUrl === settings.serverUrl;
    const accountId = settings.serverDefaults?.accountId;
    if (meta.pairing.accountId && !accountId && meta.pairing.connectionId !== settings.connectionId) return false;
    if (meta.protocol === 2) return meta.pairing.serverOrigin === originOf(settings.serverUrl) &&
        Boolean(accountId && meta.pairing.accountId === accountId);
    return meta.pairing.serverOrigin === originOf(settings.serverUrl) &&
        (!meta.pairing.accountId || !accountId || meta.pairing.accountId === accountId);
}

async function captureAuth(captureId, meta, settings, { forLookup = false } = {}) {
    if (!meta || !capturePairingMatches(meta, settings) || !settings.hasApiKey) {
        throw new Error(t("connectFirst"));
    }
    const auth = await recorderAuth(settings);
    if (!forLookup) {
        if (needsSessionProof(meta, settings)) {
            const sessionId = serverSessionFor(meta, captureId);
            if (!sessionId) throw new Error(t("connectFirst"));
            await getSession(auth, sessionId);
        }
        await confirmCapturePairing(captureId, meta, settings);
    }
    return auth;
}

function needsSessionProof(meta, settings) {
    return Boolean(meta.captureId && meta.pairing?.connectionId !== settings.connectionId);
}

function confirmCapturePairing(captureId, meta, settings) {
    const pairing = pairingFor(settings);
    if (!needsSessionProof(meta, settings) && (meta.pairing?.accountId || !pairing.accountId)) return;
    return updateCapture(captureId, { pairing: { ...pairing, accountId: meta.pairing?.accountId ?? pairing.accountId } });
}

async function recoverCaptureSession(auth, sessionId, meta, settings) {
    const session = await recoverSession(auth, sessionId);
    if (meta.protocol === 2 && (session.encryption?.protocol !== 2 ||
        !meta.sealing?.kid || session.encryption.kid !== meta.sealing.kid)) {
        await markSealedUnavailable(settings);
        throw Object.assign(new Error(t("offlineWaiting")), { kind: "capability" });
    }
    return session;
}

async function reconcileCreate(captureId, meta, auth) {
    if (meta.protocol === 2) return meta.serverSessionId;
    if (meta.createOutcome !== "unknown") return serverSessionFor(meta, captureId);
    const intent = meta.createIntent;
    const findSession = async () => sessionForIntent(await listRecordingSessions(auth), intent);
    let session = await findSession();
    if (!session) {
        if (meta.pairing?.connectionId !== auth.connectionId) throw new Error(t("connectFirst"));
        // A replay with the same client ID fences a POST which may still commit after the list.
        try {
            session = await createSession(auth, intent);
        } catch (error) {
            if (error?.status !== 409) throw error;
            session = await findSession();
            if (!session) throw error;
        }
    }
    await attachSession(captureId, session.id);
    return session.id;
}

const cleanupRequests = new Map();

function reconcileCaptureCleanup(captureId) {
    if (cleanupRequests.has(captureId)) return;
    const work = reconcileCaptureCleanupOnce(captureId)
        .catch(() => ensureUploadRetryAlarm())
        .finally(() => cleanupRequests.delete(captureId));
    cleanupRequests.set(captureId, work);
    void work.catch(() => {});
}

async function reconcileCaptureCleanupOnce(captureId) {
    let meta = await readLocalMeta(captureId);
    const settings = await getSettings();
    if (!meta?.cleanupPending) return;
    if ((await listChunkIndices(captureId)).length) meta = await retainCaptureCleanup(captureId);
    if (!meta) return;
    if (!settings.dataUseAcknowledgedAt || !settings.hasApiKey || !capturePairingMatches(meta, settings)) return;
    if (settings.serverDefaults?.offlineRecording !== true || await serverUnavailable(settings)) {
        await ensureConnectionAlarm();
        return;
    }
    const auth = await captureAuth(captureId, meta, settings, { forLookup: true });
    const signal = AbortSignal.timeout(3_000);
    try {
        if ((meta.cleanupStep ?? (meta.serverSessionId ? "cancel" : "resolve")) === "resolve") {
            const session = await createSealedSession(auth, { ...meta.createIntent, encryption: meta.sealing }, signal);
            meta = await resolveCaptureCleanup(captureId, session.id);
            if (!meta) return;
            const latest = await getSettings();
            if (!sameConnection(auth, latest)) throw new Error(t("connectFirst"));
            if (latest.serverDefaults?.offlineRecording !== true) return ensureConnectionAlarm();
        }
        await abortSession(auth, meta.serverSessionId, signal, { capture: true });
    } catch (error) {
        if (error?.kind === "capability") {
            await markSealedUnavailable(settings);
            return;
        }
        if (error?.status !== 403 || error.code !== "RECORDER_KEY_MISMATCH") throw error;
    }
    await removeCapture(captureId);
}

function discardCapture(captureId) {
    const pending = captureDiscards.get(captureId);
    if (pending) return pending;
    const work = Promise.resolve().then(async () => {
        const meta = await readLocalMeta(captureId);
        const current = await getState();
        const owner = { captureId };
        const ownsPanel = sameCapture(current, owner);
        if (ownsPanel && current.state === STATE.completed) throw new Error(t("discardAlreadySaved"));
        if (meta && meta.protocol !== 2) {
            return transitionBuffer(() => withCapture(captureId, () => discardLegacyBuffer(captureId)));
        }
        if (completeMayHaveDispatched(meta) || (ownsPanel && isPollingFinalization(current))) {
            return discardAfterComplete(captureId);
        }
        if (!meta) {
            await removeCapture(captureId);
            await resetState(owner, sameCapture, { cachedOnly: true });
            return;
        }
        const cleanup = await retainCaptureCleanup(captureId);
        if (cleanup) {
            void ensureUploadRetryAlarm().catch(() => {});
            reconcileCaptureCleanup(captureId);
        }
        await chrome.storage.session.remove(captureAgendaTitleKey(captureId));
        await resetState(owner, sameCapture, { cachedOnly: true });
        await publishPendingChange();
    }).finally(() => captureDiscards.delete(captureId));
    captureDiscards.set(captureId, work);
    if (sealedChunkUpload?.captureId === captureId) sealedChunkUpload.controller.abort();
    captureLeases.end(captureId);
    return work;
}

async function confirmLegacyDiscard(auth, sessionId, signal, knownRemote) {
    const outcome = ({ status, recording_id }) => {
        if (status === "completed" && recording_id) return "completed";
        if (status === "aborted") return "discarded";
        if (status === "completing") throw new Error(t("discardStillFinalizing"));
    };
    const remote = knownRemote ?? await getSession(auth, sessionId, signal);
    const settled = outcome(remote);
    if (settled) return settled;
    if (remote.status !== "open" && remote.status !== "failed") return;
    try {
        await abortSession(auth, sessionId, signal);
        return "discarded";
    } catch (error) {
        if (error?.status !== 409) throw error;
        return outcome(await getSession(auth, sessionId, signal));
    }
}

async function discardAfterComplete(captureId, knownRemote) {
    const meta = await updateCapture(captureId, { discardRequested: true, completeDispatched: true });
    if (!meta) throw new Error(t("discardUnconfirmed"));
    const owner = { captureId };
    let outcome;
    try {
        const auth = await captureAuth(captureId, meta, await getSettings(), { forLookup: true });
        const sessionId = serverSessionFor(meta, captureId);
        if (!sessionId) throw new Error(t("discardUnconfirmed"));
        const signal = AbortSignal.timeout(3_000);
        outcome = meta.protocol === 2
            ? await abortSession(auth, sessionId, signal, { capture: true })
            : await confirmLegacyDiscard(auth, sessionId, signal, knownRemote);
        if (outcome !== "discarded" && outcome !== "completed") throw new Error(t("discardUnconfirmed"));
    } catch (error) {
        const notice = error?.status === 409 ? new Error(t("discardStillFinalizing")) :
            error?.name === "AbortError" || error?.kind === "capability" ? new Error(t("discardUnconfirmed")) : error;
        await setState({ state: STATE.error, blocked: true, error: retryErrorMessage(notice) }, owner);
        throw notice;
    }
    await removeCapture(captureId);
    await resetState(owner, sameCapture, { cachedOnly: meta.protocol === 2 });
    if (outcome === "completed") {
        await notify(t("recordingSent"), t("discardAlreadySaved"));
        throw new Error(t("discardAlreadySaved"));
    }
}

async function cleanFailedStart(captureId, auth) {
    captureLeases.end(captureId);
    const meta = await readLocalMeta(captureId);
    if (!meta) return;
    if (meta.protocol === 2) return discardCapture(captureId);
    const sessionId = await reconcileCreate(captureId, meta, auth);
    if (sessionId !== null) {
        try {
            await abortSession(auth, sessionId);
        } catch (error) {
            if (error?.status !== 409 || (await getSession(auth, sessionId)).status !== "aborted") throw error;
        }
    }
    await removeCapture(captureId);
    await resetState({ captureId });
}

async function removeCapture(captureId) {
    await deleteCapture(captureId);
    await chrome.storage.session.remove(captureAgendaTitleKey(captureId));
    await publishPendingChange();
}

function publishPendingChange() {
    return chrome.storage.session.set({ recorderPendingRevision: crypto.randomUUID() }).catch(() => {});
}

async function discardBuffer(captureId) {
    const state = await getState();
    if (captureIdOf(state) === captureId && isLiveCapture(state)) {
        throw new Error("Stop recording before discarding its buffer");
    }
    return discardCapture(captureId);
}

async function discardLegacyBuffer(captureId) {
    const meta = await readLocalMeta(captureId);
    if (!meta) {
        await removeCapture(captureId);
        return resetState({ captureId });
    }
    const current = await getState();
    if (completeMayHaveDispatched(meta) || (captureIdOf(current) === captureId && isPollingFinalization(current))) {
        return discardAfterComplete(captureId);
    }
    const settings = await getSettings();
    if ((meta.createOutcome === "unknown" || meta.discardRequested) && (!capturePairingMatches(meta, settings) || !settings.hasApiKey)) {
        throw new Error(t("connectFirst"));
    }
    if (capturePairingMatches(meta, settings) && settings.hasApiKey) {
        const auth = await captureAuth(captureId, meta, settings, { forLookup: true });
        if (meta.createOutcome === "unknown") await updateCapture(captureId, { discardRequested: true });
        const sessionId = await reconcileCreate(captureId, meta, auth);
        if (sessionId !== null) {
            try {
                const remote = await getSession(auth, sessionId);
                if (remote.status === "completing" || remote.status === "completed") return discardAfterComplete(captureId, remote);
                if (remote.status === "open" || remote.status === "failed") await abortSession(auth, sessionId);
            } catch (error) {
                if (meta.createOutcome === "unknown" || meta.discardRequested || ![401, 403, 404].includes(error?.status)) throw error;
            }
        }
    }
    await removeCapture(captureId);
    await resetState({ captureId });
}

// ---- Startup ---------------------------------------------------------------

function recordingFolderState(meta) {
    return {
        agendaId: meta?.agendaId ?? null,
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

async function bufferedUploadState(captureId, meta, session) {
    const stored = await listChunkIndices(captureId, true);
    if (!stored.length && !(session.received_chunks?.length)) return null;
    return {
        ...IDLE_STATE,
        ...recordingFolderState(meta),
        protocol: meta.protocol ?? 1,
        bufferedOffline: meta.bufferedOffline === true,
        bufferedBytes: meta.bufferedBytes ?? 0,
        storedParts: meta.verifiedPrefix + 1 || 0,
        state: STATE.recording,
        sessionId: session.id ?? serverSessionFor(meta, captureId),
        ...(meta.captureId ? { captureId } : {}),
        bufferId: captureId,
        startedAt: meta.startedAt ?? null,
        platformHint: meta.platformHint ?? null,
        chunkCount: meta.completeIntent?.chunkCount ?? meta.chunkCount ?? verifiedPrefix(stored, session.received_chunks) + 1,
        stopped: true,
        stopReason: meta.stopReason ?? "browser-closed",
        uploaded: session.received_chunks ?? [],
    };
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
    await resumeCaptureOnWake();
    // Session storage is empty after a browser restart; re-arm open meetings.
    await reevaluateAllTabs();
    await reconcileBufferedRecordings();
    if (await totalBufferedBytes() > OPFS_WARN_BYTES) {
        await notify(t("unsentRecordings"), t("unsentRecordingsBody"));
    }
}

async function markBufferedReconciliation(captureId, meta, sessionId, error, foreground) {
    const current = await readLocalMeta(captureId);
    if (!current || current.cleanupPending || captureDiscards.has(captureId)) return;
    const outage = isConnectionError(error);
    const waiting = outage || error?.kind === "capability" || [429, 500, 502, 503, 504].includes(error?.status);
    if (meta.protocol === 2 && !waiting && error.kind === "server") {
        await refuseBufferedCapture(captureId, error, null, { stop: false, owner: foreground ?? { captureId, sessionId } });
        return;
    }
    if (foreground) {
        await claimBufferedUpload(foreground, {
            ...IDLE_STATE,
            ...recordingFolderState(meta),
            state: waiting ? STATE.recording : STATE.error,
            protocol: meta.protocol ?? 1,
            sessionId,
            ...(meta.captureId ? { captureId } : {}),
            bufferId: captureId,
            startedAt: meta.startedAt,
            chunkCount: waiting ? meta.chunkCount ?? Math.max(-1, ...await listChunkIndices(captureId)) + 1 : 0,
            stopped: true,
            blocked: !waiting,
            reconcilePending: waiting,
            error: waiting ? null : retryErrorMessage(error),
            uploadNotice: waiting && !outage ? retryErrorMessage(error) : null,
        });
    }
    if (!outage) await scheduleUploadRetry(captureId, error);
    else await ensureConnectionAlarm();
}

let bufferReconciliation;
let reconcileRequested = false;

function reconcileBufferedRecordings() {
    reconcileRequested = true;
    bufferReconciliation ??= (async () => {
        try {
            do {
                reconcileRequested = false;
                await reconcileBufferedRecordingsOnce();
            } while (reconcileRequested);
        } finally {
            bufferReconciliation = null;
        }
    })();
    return bufferReconciliation;
}

async function reconcileBufferedRecordingsOnce() {
    const settings = await getSettings();
    if (!settings.dataUseAcknowledgedAt || !settings.serverUrl || !settings.hasApiKey) return;
    const captures = await listPendingCaptures({ includeCleanup: true });
    const initial = await getState();
    const pending = [];
    for (const capture of captures) {
        const { id, meta } = capture;
        if (meta?.cleanupPending) reconcileCaptureCleanup(id);
        else if (meta?.protocol === 2 && meta.stoppedAt && !meta.refusal && !hasRecordedChunks(meta) &&
            !(captureIdOf(initial) === id && isLiveCapture(initial)) && !(await listChunkIndices(id, true)).length) {
            await discardCapture(id);
        } else pending.push(capture);
    }
    if (starting || (initial.state === STATE.awaitingPicker && !captureIdOf(initial))) return;
    if (!pending.length) {
        if (isPollingFinalization(initial) && !initial.reconcilePending) await resumeUploadWork();
        else await healStoppedUpload();
        return;
    }
    const auth = await recorderAuth(settings).catch(() => null);
    if (!auth) {
        const capture = pending.find(({ meta }) => meta && capturePairingMatches(meta, settings));
        if (capture && !isLiveCapture(initial)) await markBufferedReconciliation(
            capture.id, capture.meta, serverSessionFor(capture.meta, capture.id),
            new Error(t("keyRejected")), initial,
        );
        return;
    }

    for (const { id, meta } of pending) {
        if (starting || bufferTransitionCount) break;
        if (!meta || (meta.discardRequested && completeMayHaveDispatched(meta)) || !capturePairingMatches(meta, settings)) continue;
        const current = await getState();
        const ownsPanel = captureIdOf(current) === id;
        if (meta.captureId && meta.nextRetryAt && Date.parse(meta.nextRetryAt) > Date.now()) {
            await scheduleRetryAt(Date.parse(meta.nextRetryAt));
            continue;
        }
        if (ownsPanel && !current.reconcilePending && !meta.discardRequested) {
            if (isPollingFinalization(current)) await pollFinalization(current, auth);
            else if (isLiveCapture(current) || canPumpUploads(current) ||
                (meta.protocol === 2 && !current.sessionId && !current.blocked)) await pumpUploads();
            continue;
        }
        if (meta.blocked && !meta.discardRequested) continue;
        if (ownsPanel && isLiveCapture(current) && current.sessionId) {
            await withCapture(id, () => reconcileLiveUpload(id, meta, current, settings));
            continue;
        }
        const prepare = () => withCapture(id, () => prepareBufferedUpload(id, settings));
        const view = meta.protocol === 2 && !meta.serverSessionId ? await useUploadSlot(prepare) : await prepare();
        if (view && !bufferTransitionCount) {
            if (view.state === STATE.finalizing) {
                const { remote, ...upload } = view;
                await withCapture(id, async () => {
                    const local = await readLocalMeta(id);
                    if (!local || local.cleanupPending || local.discardRequested) return;
                    const panel = await getState();
                    const foreground = await claimBufferedUpload(panel, upload);
                    if (remote.status === "completing" && !(await readLocalMeta(id))?.completeIntent) {
                        if (!foreground) await updateCapture(id, { nextRetryAt: new Date(Date.now() + 30_000).toISOString() });
                        await ensureUploadRetryAlarm();
                    } else await pollFinalizationOnce(upload, auth, foreground ? null : { state: upload }, remote);
                });
            } else {
                await useUploadSlot(async () => {
                    const local = await readLocalMeta(id);
                    if (!local || local.cleanupPending || local.discardRequested) return;
                    const panel = await getState();
                    const foreground = await claimBufferedUpload(panel, view);
                    await pumpUploadsOnce(foreground ? null : { state: view });
                });
            }
        }
    }

}

async function reconcileLiveUpload(captureId, meta, state, settings) {
    if (await serverUnavailable(settings)) return;
    try {
        const auth = await captureAuth(captureId, meta, settings);
        let session = await getSession(auth, state.sessionId);
        if (session.status === "aborted" || session.status === "failed") {
            session = await recoverCaptureSession(auth, session.id, meta, settings);
            await attachSession(captureId, session.id);
        }
        if (session.status !== "open") return;
        const current = await getState();
        if (!sameUploadAttempt(current, state)) return;
        if (!(await setUploadState(null, { sessionId: session.id, uploaded: session.received_chunks ?? [], reconcilePending: false }, state))) return;
        void pumpUploads().catch(() => {});
    } catch (error) {
        if (meta.protocol === 2 && error.kind === "server" && error.status < 500 && error.status !== 429) {
            await refuseBufferedCapture(captureId, error, null, { stop: false, owner: state });
        } else if (isConnectionError(error) || error.kind === "capability" || error.status === 429 || error.status >= 500) {
            await scheduleUploadRetry(captureId, error);
        } else {
            await updateCapture(captureId, { blocked: true });
            await setUploadState(null, { blocked: true, reconcilePending: false, uploadNotice: retryErrorMessage(error) }, state);
        }
    }
}

function canShowBufferedUpload(panel, upload) {
    return !starting && !isLiveCapture(panel) &&
        (panel.state === STATE.idle || sameCapture(panel, upload));
}

function claimBufferedUpload(panel, upload) {
    return setState(upload, panel, (current, expected) => sameUploadAttempt(current, expected) &&
        !captureDiscards.has(captureIdOf(upload)) && canShowBufferedUpload(current, upload));
}

function hasRecordedChunks(meta) {
    return meta.chunkCount > 0 || meta.uploadedParts > 0 || meta.highestCommittedIndex >= 0 || meta.verifiedPrefix >= 0;
}

async function prepareBufferedUpload(captureId, settings) {
    let meta = await readLocalMeta(captureId);
    if (!meta || meta.cleanupPending || (meta.discardRequested && completeMayHaveDispatched(meta)) ||
        !capturePairingMatches(meta, settings)) return null;
    let sessionId = serverSessionFor(meta, captureId);
    try {
        const auth = await captureAuth(captureId, meta, settings, { forLookup: true });
        if (!meta.stoppedAt) {
            const current = await getState();
            if (captureIdOf(current) === captureId && isLiveCapture(current)) return null;
            const stored = await listChunkIndices(captureId, true);
            const empty = !stored.length && !hasRecordedChunks(meta);
            if (meta.protocol === 2 && empty && (meta.createIntent || meta.serverSessionId === null)) {
                await discardCapture(captureId);
                return null;
            }
            if (meta.captureId && empty && (meta.createIntent || meta.serverSessionId === null)) {
                await updateCapture(captureId, { discardRequested: true });
                meta = { ...meta, discardRequested: true };
            }
            if (meta.captureId) {
                captureLeases.end(captureId);
                meta = await markStopped(captureId, { stopReason: "browser-closed" }) ?? meta;
            }
            if (stored.length && meta.captureId) await notify(t("recordingStopped"), t("meetingPromptStopped"));
        }
        if (meta.discardRequested) {
            await cleanFailedStart(captureId, auth);
            return null;
        }
        let session;
        if (meta.protocol === 2 && !sessionId) {
            session = await openSealedCapture(captureId, meta, settings);
            if (!session) return null;
            sessionId = session.id;
        } else {
            sessionId = await reconcileCreate(captureId, meta, auth);
            if (sessionId === null) return null;
            session = await getSession(auth, sessionId);
        }
        await confirmCapturePairing(captureId, meta, settings);
        if (session.status === "completed" || session.status === "completing") {
            return {
                ...IDLE_STATE, ...recordingFolderState(meta), state: STATE.finalizing, protocol: meta.protocol ?? 1,
                captureId: meta.captureId ?? null, bufferId: captureId, sessionId,
                startedAt: meta.startedAt, stopped: true, jobId: session.job_id,
                serverCompleting: true, ...newFinalizationAttempt(), remote: session,
            };
        }
        if (session.status === "aborted" || session.status === "failed") {
            session = await recoverCaptureSession(auth, sessionId, meta, settings);
            await attachSession(captureId, session.id);
        }
        if (session.status !== "open") return null;
        const current = await getState();
        if (current.reconcilePending && captureIdOf(current) === captureId) {
            await updateLocalMeta(captureId, { retryAttempt: 0, nextRetryAt: null });
        }
        return bufferedUploadState(captureId, meta, session);
    } catch (error) {
        const current = await getState();
        const foreground = !needsSessionProof(meta, settings) && canShowBufferedUpload(current, { captureId });
        await markBufferedReconciliation(captureId, meta, sessionId, error, foreground && !meta.discardRequested ? current : null);
        return null;
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
void resumeCaptureOnWake().then(getState).then(async (state) => {
    if (state.sessionId && isPollingFinalization(state)) await ensureUploadRetryAlarm();
    else if (state.protocol === 2 && state.stopped && !state.sessionId && !state.blocked) await reconcileBufferedRecordings();
    else if (state.reconcilePending) await resumeUploadWork();
    else if (state.captureId && (isLiveCapture(state) || (state.stopped && canPumpUploads(state)))) await reconcileBufferedRecordings();
    else await healStoppedUpload();
}).catch(() => {});
