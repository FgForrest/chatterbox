import { request } from "./api.js";
import { t } from "./i18n.js";
import { pickerWindowBounds } from "./picker-window.js";
import { getSettings } from "./settings.js";
import { readToken } from "./token-vault.js";

export const AGENDA_ALARM_PREFIX = "agenda:";
export const AGENDA_CACHE_KEY = "recorderAgendas";
export const AGENDA_PANEL_KEY = "recorderAgendaPanel";
export const AGENDA_SELECTION_KEY = "recorderAgendaSelection";

/** Whether the paired server explicitly supports recorder agendas. */
export function supportsAgendas(settings) {
    return Boolean(
        settings.dataUseAcknowledgedAt &&
            settings.hasApiKey &&
            settings.serverUrl &&
            settings.serverDefaults?.agendas === true,
    );
}

/** Call an agenda route only after capability detection. */
export async function agendaRequest(path = "", init = {}) {
    const settings = await getSettings();
    if (!supportsAgendas(settings)) throw new Error(t("agendaUnsupported"));
    const apiKey = await readToken();
    const latest = await getSettings();
    if (
        !supportsAgendas(latest) ||
        latest.serverUrl !== settings.serverUrl ||
        latest.connectionId !== settings.connectionId
    )
        throw new Error(t("agendaUnsupported"));
    const response = await request(
        { serverUrl: settings.serverUrl, apiKey },
        `/api/v1/recorder/agendas${path}`,
        init,
    );
    const body = await response.json();
    const current = await getSettings();
    if (
        !supportsAgendas(current) ||
        current.serverUrl !== settings.serverUrl ||
        current.connectionId !== settings.connectionId
    )
        throw new Error(t("agendaUnsupported"));
    return body;
}

/** Agendas currently running or starting within fifteen minutes. */
export function currentAgendas(rows, now = Date.now()) {
    return rows.filter((row) => {
        const start = Date.parse(row.start);
        const end = row.end ? Date.parse(row.end) : start + 2 * 3600000;
        return (
            Number.isFinite(start) &&
            start <= now + 15 * 60000 &&
            end > now &&
            row.state !== "held"
        );
    });
}

/** Match server-side, sending only a Meet room code, never a tab URL. */
export async function matchAgendas(tabUrl, now = Date.now(), init = {}) {
    if (!supportsAgendas(await getSettings())) return [];
    const query = new URLSearchParams({ at: new Date(now).toISOString() });
    if (tabUrl) {
        const url = new URL(tabUrl);
        if (url.hostname === "meet.google.com") {
            const code = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/i.exec(
                url.pathname,
            )?.[1];
            if (!code) return [];
            query.set("meetCode", code.toLowerCase());
        }
    }
    const body = await agendaRequest(`/match?${query}`, init);
    return currentAgendas(Array.isArray(body.data) ? body.data : [], now);
}

/** Clear cached agenda content, pending choices and reminder alarms. */
export async function clearAgendas() {
    const stored = await chrome.storage.session.get(null);
    const keys = [
        AGENDA_CACHE_KEY,
        AGENDA_PANEL_KEY,
        AGENDA_SELECTION_KEY,
        ...Object.keys(stored).filter((key) => key.startsWith("agenda-match:")),
    ];
    await chrome.storage.session.remove(keys);
    await clearAgendaReminders();
}

/** Remove only agenda alarms and notifications, preserving recording choices. */
export async function clearAgendaReminders() {
    const alarms = (await chrome.alarms?.getAll?.()) ?? [];
    await Promise.all(
        alarms
            .filter((alarm) => alarm.name.startsWith(AGENDA_ALARM_PREFIX))
            .map((alarm) => chrome.alarms.clear(alarm.name)),
    );
    const notifications = (await chrome.notifications?.getAll?.()) ?? {};
    await Promise.all(
        Object.keys(notifications)
            .filter((id) => id.startsWith(AGENDA_ALARM_PREFIX))
            .map((id) => chrome.notifications.clear(id)),
    );
}

/** Refresh the next day's agendas with the recorder configuration. */
export async function refreshAgendas() {
    const settings = await getSettings();
    if (!supportsAgendas(settings)) {
        await clearAgendas();
        return;
    }
    const now = Date.now();
    const query = new URLSearchParams({
        from: new Date(now).toISOString(),
        to: new Date(now + 86400000).toISOString(),
    });
    const identity = (await chrome.storage.local.get("encryptedApiKey"))
        .encryptedApiKey;
    const body = await agendaRequest(`?${query}`);
    const latest = await getSettings();
    if (
        !supportsAgendas(latest) ||
        latest.serverUrl !== settings.serverUrl ||
        latest.connectionId !== settings.connectionId ||
        JSON.stringify(
            (await chrome.storage.local.get("encryptedApiKey")).encryptedApiKey,
        ) !== JSON.stringify(identity)
    )
        return;
    const agendas = (Array.isArray(body.data) ? body.data : []).filter(
        (row) => row.timeSet && row.state !== "held",
    );
    await chrome.storage.session.set({
        [AGENDA_CACHE_KEY]: {
            serverUrl: settings.serverUrl,
            connectionId: settings.connectionId,
            agendas,
        },
    });
    await clearAgendaReminders();
    if (!latest.agendaReminders) return;
    for (const agenda of agendas) {
        const when = Date.parse(agenda.start) - 60000;
        if (when > now)
            await chrome.alarms.create(`${AGENDA_ALARM_PREFIX}${agenda.id}`, {
                when,
            });
    }
}

/** Show a reminder only while the current pairing and settings still allow it. */
export async function remindAgenda(id) {
    const settings = await getSettings();
    if (!supportsAgendas(settings) || !settings.agendaReminders) return;
    const cached = (await chrome.storage.session.get(AGENDA_CACHE_KEY))[
        AGENDA_CACHE_KEY
    ];
    const agenda =
        cached?.serverUrl === settings.serverUrl &&
        cached.connectionId === settings.connectionId
            ? cached.agendas.find((row) => row.id === id)
            : null;
    if (!agenda || Date.parse(agenda.start) + 60000 < Date.now()) return;
    const time = new Date(agenda.start).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
    });
    await chrome.notifications.create(`${AGENDA_ALARM_PREFIX}${id}`, {
        type: "basic",
        iconUrl: "icons/icon-128.png",
        title: t("agendaReminderTitle", [agenda.title, time]),
        message: t("agendaCounts", [
            String(agenda.counts?.points ?? 0),
            String(agenda.counts?.tasks ?? 0),
        ]),
        buttons: [
            { title: t("agendaShow") },
            { title: t("meetingPromptDismiss") },
        ],
    });
}

/** Open from the original user gesture; use the same page in a window on refusal. */
export function openAgendaPanel(context = {}, agendaIds = []) {
    let opened;
    try {
        // Chrome requires this call before any await in the click handler.
        opened = chrome.sidePanel.open(
            context.tabId != null
                ? { tabId: context.tabId }
                : {
                      windowId:
                          context.windowId ?? chrome.windows.WINDOW_ID_CURRENT,
                  },
        );
    } catch (error) {
        opened = Promise.reject(error);
    }
    const selected = chrome.storage.session.set({
        [AGENDA_PANEL_KEY]: { agendaIds, choose: agendaIds.length !== 1 },
    });
    return Promise.resolve(opened)
        .then(() => selected)
        .catch(async () => {
            await selected;
            const anchor = await chrome.windows
                .getLastFocused({ windowTypes: ["normal"] })
                .catch(() => null);
            const bounds = pickerWindowBounds(anchor);
            const width = 430;
            const height = 640;
            await chrome.windows.create({
                url: chrome.runtime.getURL("agenda/agenda.html"),
                type: "popup",
                focused: true,
                width,
                height,
                ...(bounds.left != null
                    ? {
                          left:
                              bounds.left +
                              Math.round((bounds.width - width) / 2),
                          top:
                              bounds.top +
                              Math.round((bounds.height - height) / 2),
                      }
                    : {}),
            });
        });
}

/** Completion remains unchanged on servers that do not advertise agendas. */
export function agendaCompletion(settings, state) {
    return supportsAgendas(settings) && state.agendaExplicit === true
        ? { agendaId: state.agendaId ?? null }
        : {};
}

/** Map the first agenda folder to the existing recorder folder selection. */
export function agendaFolder(agenda) {
    const folder = agenda?.folders?.[0];
    return folder
        ? { folderId: folder.id, folderLabel: agenda.folderPath || folder.name }
        : {};
}

/** Allow correcting an agenda before completion, including a refused completion retry. */
export function canChooseRecordingAgenda(state) {
    return Boolean(
        state.sessionId &&
            ((state.state === "recording" && !state.stopped) ||
                (state.state === "error" && state.stopped && !state.jobId)),
    );
}
