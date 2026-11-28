import "./recording-levels.js";
import { createAgendaCard } from "../lib/agenda-card.js";
import { agendaFolder, supportsAgendas } from "../lib/agendas.js";
import { mountConnectionNotice } from "../lib/connection-notice.js";
import { STATE } from "../lib/constants.js";
import { localizeDocument, t } from "../lib/i18n.js";
import { bindMeetingPromptOffer } from "../lib/meeting-prompt-ui.js";
import { meetingRoom } from "../lib/meeting-room.js";
import { meetingTarget } from "../lib/meeting-target.js";
import { microphonePermission } from "../lib/microphone.js";
import { originOf } from "../lib/pairing.js";
import { detectMeetingPlatform } from "../lib/platforms.js";
import { roomPairingChanged, roomRecorderClock, supportsRoomRecorders } from "../lib/room-recorders.js";
import { recordingStartPath, sealedRecipient } from "../lib/sealed-recording.js";
import { formatBufferedBytes } from "../lib/pending-recordings.js";
import { isWaitingForUpload } from "../lib/upload-state.js";
import {
    customNoticeText,
    effectivePlatformModes,
    getSettings,
    isPaired,
    saveSettings,
} from "../lib/settings.js";

import {
    createFolderField,
    createRecordingFolder,
} from "../generated/folders.js";
import { createNextMeetingCard } from "../lib/next-meeting-card.js";

const { dbToWidth } = globalThis.recorderLevels;

/** Mount one recording widget body in the popup or agenda panel. */
export async function mountRecordingControls(
    root,
    {
        variant = "popup",
        tabId,
        agendaChoice = () => ({}),
        onState = () => {},
        onTab = () => {},
        onRoomRecorders = () => {},
        idleNotice,
        beforeAction = async () => {},
        onConnection = () => {},
    } = {},
) {
    if (!root.querySelector("#view-idle")) {
        const response = await fetch(chrome.runtime.getURL("popup/popup.html"));
        const parsed = new DOMParser().parseFromString(
            await response.text(),
            "text/html",
        );
        for (const script of parsed.querySelectorAll("script")) script.remove();
        root.replaceChildren(
            ...Array.from(parsed.body.childNodes).map((node) =>
                document.importNode(node, true),
            ),
        );
    }
    if (variant === "panel") root.querySelector("header").hidden = true;
    const views = {
        connect: root.querySelector("#" + "view-connect"),
        unpaired: root.querySelector("#" + "view-unpaired"),
        idle: root.querySelector("#" + "view-idle"),
        recording: root.querySelector("#" + "view-recording"),
        finalizing: root.querySelector("#" + "view-finalizing"),
        completed: root.querySelector("#" + "view-completed"),
        error: root.querySelector("#" + "view-error"),
    };

    if (idleNotice) views.idle.querySelector("#idle-hint").before(idleNotice);

    localizeDocument();

    const el = (id) => root.querySelector("#" + id);

    let elapsedTimer;
    let finalizationTimer;
    let renderVersion = 0;
    let tabVersion = 0;
    let currentSessionId = null;
    let currentCaptureId = null;
    let currentRecoverablePrefix = null;
    let currentTab = null;
    let currentPlatform = null;
    let currentState = { state: STATE.idle };
    let meetingCard;
    let unavailable = false;
    let canRecordOffline = false;
    let roomContext;
    let roomPoll;
    let namesExpire;
    let visibleRoomNames = "[]";
    const notice = mountConnectionNotice(views.connect, {
        onConnection(connection) {
            const previous = unavailable;
            unavailable = Boolean(connection && connection.state !== "ok");
            onConnection(unavailable);
            if (previous !== unavailable) void render(currentState);
        },
    });

    async function renderMicrophoneWarning(state) {
        const settings = await getSettings();
        if (!settings.dataUseAcknowledgedAt) {
            el("mic-warning").hidden = true;
            return;
        }
        const permission = await microphonePermission();
        const reminder =
            settings.dataUseAcknowledgedAt &&
            !settings.micReminderDismissed &&
            permission !== "granted";
        el("mic-warning").hidden =
            !settings.dataUseAcknowledgedAt || state.stopped || !(state.micWarning || reminder);
        el("mic-warning-text").textContent =
            state.micWarning || t("micWarning");
        el("dismiss-mic").hidden =
            !reminder || !state.withoutMicrophone || Boolean(state.micWarning);
    }

    function show(name) {
        for (const [key, node] of Object.entries(views)) {
            node.hidden = key !== name;
        }
        if (name !== "idle") {
            folderCombobox.close();
            clearRoomRecorders();
        }
        if (name !== "recording") recordingFolder.close();
    }

    function sendMessage(message) {
        return chrome.runtime.sendMessage(message);
    }

    function captureMessage(type, fields = {}) {
        return sendMessage({ type, ...fields, ...(currentCaptureId ? { captureId: currentCaptureId } : {}) });
    }

    async function activeTab() {
        const id = typeof tabId === "function" ? tabId() : tabId;
        if (id != null) return chrome.tabs.get(id).catch(() => null);
        const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
        });
        return tab ?? null;
    }

    function showRoomRecorders(names) {
        const visible = names.slice(0, 3);
        const list = visible.map(name => name || t("roomRecorderColleague")).join(", ");
        const overflow = names.length > visible.length ? ` +${names.length - visible.length}` : "";
        const label = names.length ? t(names.length === 1 ? "roomRecorderOne" : "roomRecorderSeveral", list + overflow) : "";
        if (label !== el("room-recorder-names").textContent) el("room-recorder-names").textContent = label;
        el("room-recorder-notice").hidden = !label;
        const named = visible.filter(Boolean);
        const signature = JSON.stringify(named);
        if (signature !== visibleRoomNames) {
            visibleRoomNames = signature;
            onRoomRecorders(named);
        }
    }

    function clearRoomRecorders() {
        if (!roomContext) return;
        roomContext = null;
        clearInterval(roomPoll);
        clearTimeout(namesExpire);
        showRoomRecorders([]);
    }

    async function refreshRoomRecorders(recheck = true) {
        const target = roomContext;
        if (!target || target.pending) return;
        target.pending = true;
        const result = await sendMessage({ type: "room-recorders", tabId: target.tabId }).catch(() => null);
        target.pending = false;
        if (roomContext !== target) return;
        clearTimeout(namesExpire);
        const remaining = (result?.expiresAt ?? 0) - roomRecorderClock();
        const names = remaining > 0 && Array.isArray(result?.names)
            ? result.names.map(name => name.trim())
            : [];
        showRoomRecorders(names);
        if (recheck && remaining <= 0 && result?.names?.length && Number.isFinite(result.expiresAt)) {
            void refreshRoomRecorders(false);
        } else if (names.length) namesExpire = setTimeout(() => {
            showRoomRecorders([]);
            void refreshRoomRecorders();
        }, remaining);
    }

    function watchRoomRecorders(settings) {
        const eligible = currentState.state === STATE.idle && supportsRoomRecorders(settings) &&
            currentTab?.id != null && currentTab.active !== false;
        const room = eligible ? meetingRoom(currentTab.url) : null;
        if (!room) {
            clearRoomRecorders();
            return;
        }
        if (roomContext?.tabId === currentTab.id && roomContext.room === room) return;
        clearRoomRecorders();
        roomContext = { tabId: currentTab.id, room };
        void refreshRoomRecorders();
        if (variant === "popup") roomPoll = setInterval(refreshRoomRecorders, 15_000);
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

    let popupFolderChoice;
    let agendaFolderChoice;
    const folderCombobox = createFolderField({
        container: el("folder-row"),
        request: (params) => sendMessage({ type: "get-folders", ...params }),
        save: (folder) => {
            popupFolderChoice = folder;
            return saveSettings(folder);
        },
        saveOnRefresh: saveSettings,
        t,
    });
    const recordingFolder = createRecordingFolder({
        container: el("recording-folder-row"),
        prefix: "recording-folder",
        request: (params) => sendMessage({ type: "get-folders", ...params }),
        send: sendMessage,
        t,
    });

    let agendaCard;
    async function renderAgendaCard(settings, state) {
        const container = el("agenda-card");
        if (variant === "panel") {
            container.hidden = true;
            return;
        }
        if (!container) return;
        if (!supportsAgendas(settings)) {
            container.hidden = true;
            return;
        }
        agendaCard ??= createAgendaCard(container, {
            tab: () => currentTab,
            onFolder: (agenda) => {
                if (currentState.state === STATE.idle && !popupFolderChoice)
                    folderCombobox.reset(agendaFolder(agenda), {
                        refresh: false,
                    });
            },
        });
        await agendaCard(settings, state, unavailable);
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
        canRecordOffline = Boolean(sealedRecipient(settings));
        notice.update({ sealed: canRecordOffline });
        const hint = el("idle-hint");
        hint.hidden = false;
        el("start").hidden = false;
        const autoHint = el("auto-hint");
        autoHint.hidden = true;
        el("start").textContent = t("recordTabWithConsent");
        el("notice-text").textContent = customNoticeText(settings);
        el("notice-text").hidden = !el("notice-text").textContent;
        el("picker-hint").hidden = false;
        folderCombobox.reset(popupFolderChoice ?? agendaFolderChoice ?? settings, unavailable ? { refresh: false } : undefined);

        if (currentPlatform) {
            hint.textContent = t("recordThis", currentPlatform.name);
            const mode =
                effectivePlatformModes(settings)[currentPlatform.id]?.mode;
            if (mode === "off") {
                autoHint.hidden = false;
                autoHint.textContent = t("autoTip", currentPlatform.name);
            }
        } else {
            hint.textContent = t("noMeeting");
        }
        show("idle");
        watchRoomRecorders(settings);
        void renderAgendaCard(settings, currentState);
    }

    async function startRecording(forceDesktop = false) {
        const settings = getSettings();
        const tabId = currentTab?.id;
        const target = meetingTarget(currentTab?.url);
        const platformHint = currentPlatform?.id;
        const noticeAcknowledgedAt = new Date().toISOString();
        const choice =
            variant === "panel" ? agendaChoice() : (agendaCard?.choice() ?? {});
        const button = el(forceDesktop ? "start-desktop" : "start");
        el("start").disabled = true;
        el("start-desktop").disabled = true;
        button.textContent = t(
            unavailable && !canRecordOffline ? "connectionConnecting" : forceDesktop ? "openingPicker" : "startingCapture",
            t("appNameInstrumental", t("appName")),
        );
        try {
            const startPath = recordingStartPath(await settings);
            if (!startPath.recipient) {
                await beforeAction();
                await folderCombobox.saved();
            }
            const response = await sendMessage({
                type: "start-recording",
                payload: {
                    forceDesktop,
                    tabId,
                    ...(target ? { meetingTarget: target } : {}),
                    platformHint,
                    noticeAcknowledgedAt,
                    startPath,
                    ...choice,
                    ...(popupFolderChoice ?? {}),
                },
            });
            if (response?.ok !== true) {
                if (response?.connection) return;
                throw new Error(response?.error ?? t("couldNotStart"));
            }
            if (variant === "popup") window.close();
        } catch (error) {
            el("error-text").textContent = error?.message ?? String(error);
            show("error");
        } finally {
            el("start").disabled = false;
            el("start-desktop").disabled = false;
            button.textContent = t(
                forceDesktop ? "recordAnotherSource" : "recordTabWithConsent",
            );
        }
    }
    el("start").addEventListener("click", () => startRecording());
    el("start-desktop").addEventListener("click", () => startRecording(true));

    // ---- Recording / finalizing / error --------------------------------------

    function renderUploadStatus(state, elementId = "upload-status") {
        const node = el(elementId);
        if (!node) return;
        const uploaded = state.uploaded?.length ?? 0;
        const total = state.storedParts ?? 0;
        if (!state.stopped && state.protocol === 2 && unavailable) {
            node.classList.add("local-audio");
            node.textContent = t("offlineSavedBytes", formatBufferedBytes(state.bufferedBytes ?? 0));
            return;
        }
        node.classList.remove("local-audio");
        if (!state.stopped && state.protocol === 2 && state.bufferedOffline && uploaded < total && !state.uploadNotice) {
            node.textContent = t("offlineSendingLive", [String(uploaded), String(total)]);
            return;
        }
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
        const local = state.protocol === 2 && unavailable && !processing;
        const nextRecording = el("record-next");
        if (nextRecording) nextRecording.hidden = state.protocol !== 2;
        el("finalizing-stage").hidden = local;
        el("finalizing-stage").textContent = t(
            processing ? "processingRecording" : "uploadingRecording",
        );
        el("finalizing-upload").hidden = processing || local;
        el("finalizing-processing").hidden = !processing;
        el("finalizing-progress").setAttribute(
            "aria-valuenow",
            String(percent),
        );
        el("finalizing-progress").setAttribute(
            "aria-label",
            t("uploadProgress"),
        );
        el("finalizing-progress-fill").style.width = `${percent}%`;
        renderUploadStatus(state, "finalizing-status");
        if (processing) {
            const uploadedStatus = t("uploadComplete", String(total));
            el("processing-status").textContent = state.uploadNotice
                ? `${uploadedStatus} ${state.uploadNotice}`
                : uploadedStatus;
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
        if (state.state !== STATE.idle) clearRoomRecorders();
        const live = !state.stopped && (state.state === STATE.recording ||
            ((state.captureId || state.sessionId) && state.captureMode && state.state === STATE.error));
        notice.update({
            recording: live, starting: state.startConnectionError || state.connecting,
            sealed: state.protocol === 2 || (state.state === STATE.idle && canRecordOffline), stopped: state.stopped && state.state !== STATE.completed,
        });
        const badge = el("offline-badge");
        if (badge) badge.hidden = !live || !unavailable;
        const storageWarning = el("local-storage-warning");
        if (storageWarning) storageWarning.hidden = !live || !state.localStorageWarning;
        onState(state);
        void meetingCard?.render();
        if (state.state !== STATE.idle)
            void getSettings().then((settings) =>
                renderAgendaCard(settings, state),
            );
        await renderMicrophoneWarning(state);
        if (version !== renderVersion) return;
        currentSessionId = state.sessionId;
        currentCaptureId = state.captureId;
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

        const waitingForUpload = isWaitingForUpload(state);
        if (waitingForUpload && !finalizationTimer) {
            finalizationTimer = setInterval(() => {
                void captureMessage("check-finalization").catch(
                    () => {},
                );
            }, 5000);
        } else if (!waitingForUpload && finalizationTimer) {
            clearInterval(finalizationTimer);
            finalizationTimer = undefined;
        }

        if (live && state.state === STATE.error) state = { ...state, state: STATE.recording, uploadNotice: state.error };
        switch (state.state) {
            case STATE.recording: {
                if (state.stopped) {
                    renderFinalizing(state);
                    break;
                }
                show("recording");
                recordingFolder.render(state, unavailable || (state.protocol === 2 && !state.sessionId) ? { refresh: false } : undefined);
                el("mic-bar").style.width = dbToWidth(state.levels?.micDb ?? -100);
                el("sys-bar").style.width = dbToWidth(state.levels?.systemDb ?? -100);
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
                el("completion-agenda-notice").textContent =
                    state.agendaUnavailable ? t("agendaUnavailable") : "";
                show("completed");
                break;
            case STATE.awaitingPicker:
                show("idle");
                el("idle-hint").textContent = state.connecting
                    ? t("connectionConnecting", t("appNameInstrumental", t("appName")))
                    : t("waitingPicker");
                break;
            case STATE.error:
                if (state.startConnectionError) {
                    await renderIdle(version);
                    break;
                }
                show("error");
                el("retry").hidden = !(state.sessionId || (state.protocol === 2 && state.captureId));
                el("discard").textContent = t(state.sessionId || state.captureId ? "discard" : "dismiss");
                el("error-text").textContent =
                    state.error ?? t("somethingWrong");
                el("partial-recovery").hidden = !(state.recoverablePrefix > 0);
                if (state.recoverablePrefix > 0) {
                    el("partial-recovery-detail").textContent = t(
                        "partialRecoveryDetail",
                        [
                            String(state.recoverablePrefix),
                            String(state.chunkCount),
                        ],
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
        if (!unavailable) void beforeAction().catch(() => {});
        await captureMessage("stop-recording", { reason: "user" });
    });

    el("retry").addEventListener("click", async () => {
        const result = await captureMessage("retry-upload");
        if (result?.ok === false) {
            el("error-text").textContent =
                result.error ?? t("recoveryUnavailable");
        }
    });

    el("partial-recovery-check").addEventListener("change", (event) => {
        el("save-prefix").disabled = !event.target.checked;
    });

    el("save-prefix").addEventListener("click", async () => {
        if (!el("partial-recovery-check").checked || !currentRecoverablePrefix)
            return;
        const response = await captureMessage("save-prefix", {
            chunkCount: currentRecoverablePrefix,
        });
        if (response?.ok === false)
            el("error-text").textContent = response.error;
    });

    el("record-next")?.addEventListener("click", () => void captureMessage("dismiss-pending-capture"));
    el("discard").addEventListener("click", async () => {
        if (currentCaptureId && !currentSessionId && !window.confirm(t("discardOfflineConfirm"))) return;
        const result = await captureMessage("discard-session", {
            sessionId: currentSessionId,
        });
        if (result?.ok === false) el("error-text").textContent = result.error;
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
        offer: el("meeting-prompt-offer"),
        enable: el("enable-meeting-prompt"),
        dismiss: el("dismiss-meeting-prompt"),
        status: el("meeting-prompt-offer-status"),
    });

    // ---- Live updates --------------------------------------------------------

    const listener = (message) => {
        if (message?.type === "state") {
            void render(message.state);
        } else if (message?.type === "levels" &&
            (!message.captureId || message.captureId === currentState.captureId)) {
            el("mic-bar").style.width = dbToWidth(message.micDb);
            el("sys-bar").style.width = dbToWidth(message.systemDb);
        }
    };
    chrome.runtime.onMessage.addListener(listener);

    // Initial paint.
    await notice.ready;
    await (async () => {
        void sendMessage({ type: "reevaluate-tabs" }).catch(() => {});
        currentTab = await activeTab();
        currentPlatform = currentTab?.url
            ? detectMeetingPlatform(currentTab.url)
            : null;
        onTab(currentTab);
        const response = await sendMessage({ type: "get-state" });
        await render(response?.state ?? { state: STATE.idle });
    })();

    meetingCard = createNextMeetingCard(
        el("next-meeting-card"),
        () => currentTab,
        { popup: variant === "popup", state: () => currentState },
    );
    if (variant === "panel") el("view-idle").prepend(el("next-meeting-card"));
    const tabUpdated = (id, change, tab) => {
        if (id !== currentTab?.id) return;
        if (change.status === "loading") clearRoomRecorders();
        if (!change.url && change.status !== "complete") return;
        tabVersion++;
        if (change.url) clearRoomRecorders();
        currentTab = tab;
        currentPlatform = detectMeetingPlatform(tab.url);
        if (change.url) onTab(currentTab);
        if (currentState.state === STATE.idle) void render(currentState);
        void meetingCard.render();
    };
    chrome.tabs.onUpdated?.addListener(tabUpdated);
    const tabActivated = async (info) => {
        if (info && info.windowId === currentTab?.windowId && info.tabId !== currentTab?.id) clearRoomRecorders();
        const version = ++tabVersion;
        const tab = await activeTab();
        if (version !== tabVersion) return;
        if (currentTab?.id !== tab?.id || currentTab?.url !== tab?.url || currentTab?.active !== tab?.active) {
            clearRoomRecorders();
        }
        currentTab = tab;
        currentPlatform = detectMeetingPlatform(currentTab?.url);
        onTab(currentTab);
        if (currentState.state === STATE.idle) await render(currentState);
        void meetingCard.render();
    };
    chrome.tabs.onActivated?.addListener(tabActivated);
    const tabRemoved = (id) => {
        if (id === currentTab?.id) {
            clearRoomRecorders();
            void tabActivated();
        }
    };
    chrome.tabs.onRemoved?.addListener(tabRemoved);
    const settingsChanged = (changes, area) => {
        if (area === "local" && roomPairingChanged(changes)) clearRoomRecorders();
        if (
            area !== "local" ||
            !(
                changes.serverUrl ||
                changes.encryptedApiKey ||
                changes.dataUseAcknowledgedAt || changes.serverDefaults || changes.noticeText
            )
        )
            return;
        popupFolderChoice = undefined;
        folderCombobox.reset({}, { clear: true, refresh: false });
        void render(currentState);
    };
    chrome.storage.onChanged.addListener(settingsChanged);
    return {
        render,
        refreshTab: tabActivated,
        refreshMeeting: () => meetingCard.render(),
        refreshRoomRecorders,
        folder: (folder) => {
            agendaFolderChoice = folder;
            if (!popupFolderChoice)
                folderCombobox.reset(folder, { refresh: false });
        },
        destroy: () => {
            clearInterval(elapsedTimer);
            clearInterval(finalizationTimer);
            clearRoomRecorders();
            tabVersion++;
            chrome.runtime.onMessage.removeListener?.(listener);
            chrome.tabs.onUpdated?.removeListener(tabUpdated);
            chrome.tabs.onActivated?.removeListener(tabActivated);
            chrome.tabs.onRemoved?.removeListener(tabRemoved);
            chrome.storage.onChanged.removeListener?.(settingsChanged);
            notice.destroy();
            meetingCard.destroy();
            folderCombobox.destroy();
            recordingFolder.destroy();
        },
    };
}
