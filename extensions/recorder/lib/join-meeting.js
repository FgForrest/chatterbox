import { agendaPanelKey } from "./agendas.js";
import { meetCode } from "./meet-code.js";
import { getSettings } from "./settings.js";

export const MEETING_TAB_PREFIX = "meeting-tab:";
export const MEETING_END_PREFIX = "meeting-tab-end:";

let changes = Promise.resolve();

function changeMeetings(change) {
    const work = changes.catch(() => {}).then(change);
    changes = work;
    return work;
}

async function clearJoinedMeetingNow(tabId) {
    const { recordingState } = await chrome.storage.session.get("recordingState");
    const keepPanel = recordingState?.tabId === tabId && recordingState.agendaId &&
        ["recording", "finalizing"].includes(recordingState.state);
    await chrome.storage.session.remove([
        `${MEETING_TAB_PREFIX}${tabId}`,
        ...(!keepPanel ? [agendaPanelKey(tabId), `agenda-route:${tabId}`] : []),
    ]);
    await chrome.alarms.clear(`${MEETING_END_PREFIX}${tabId}`);
}

/** Serialize removal with Join publication so a closed tab cannot regain its binding. */
export function clearJoinedMeeting(tabId) {
    return changeMeetings(() => clearJoinedMeetingNow(tabId));
}

function validBinding(binding, settings) {
    return binding && binding.serverUrl === settings.serverUrl && binding.connectionId === settings.connectionId &&
        settings.dataUseAcknowledgedAt && settings.hasApiKey &&
        Number.isFinite(Date.parse(binding.end)) && Date.parse(binding.end) > Date.now();
}

/** Resolve the current pairing's Join identity before URL matching. */
export async function joinedMeeting(tab, settings) {
    if (tab?.id == null) return null;
    const binding = (await chrome.storage.session.get(`${MEETING_TAB_PREFIX}${tab.id}`))[`${MEETING_TAB_PREFIX}${tab.id}`];
    if (!binding) return null;
    if (!validBinding(binding, settings) || binding.roomCode !== meetCode(tab.pendingUrl || tab.url)) {
        await clearJoinedMeeting(tab.id);
        return null;
    }
    return binding;
}

/** Restore end alarms for live tab bindings after the worker wakes. */
export function reconcileJoinedMeetings() {
    return changeMeetings(async () => {
        const settings = await getSettings();
        const stored = await chrome.storage.session.get(null);
        for (const [key, binding] of Object.entries(stored)) {
            if (!key.startsWith(MEETING_TAB_PREFIX)) continue;
            const tabId = Number(key.slice(MEETING_TAB_PREFIX.length));
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            if (!tab || !validBinding(binding, settings) || binding.roomCode !== meetCode(tab.pendingUrl || tab.url)) {
                await clearJoinedMeetingNow(tabId);
                continue;
            }
            await chrome.alarms.create(`${MEETING_END_PREFIX}${tabId}`, { when: Date.parse(binding.end) });
        }
        for (const alarm of (await chrome.alarms.getAll?.()) ?? []) {
            if (!alarm.name.startsWith(MEETING_END_PREFIX)) continue;
            const key = `${MEETING_TAB_PREFIX}${alarm.name.slice(MEETING_END_PREFIX.length)}`;
            if (!(await chrome.storage.session.get(key))[key]) await chrome.alarms.clear(alarm.name);
        }
    });
}

/** Publish only a live tab still in the validated room, serialized with tab removal. */
export function publishJoinedMeeting(meeting, tabId, onRoute = () => {}) {
    return changeMeetings(async () => {
        const settings = await getSettings();
        const roomCode = meetCode(meeting?.joinUrl);
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!roomCode || !validBinding(meeting, settings) || !tab || roomCode !== meetCode(tab.pendingUrl || tab.url))
            throw new Error("Meeting unavailable");
        const binding = { agendaId: meeting.agendaId ?? null, end: meeting.end, roomCode, serverUrl: settings.serverUrl, connectionId: settings.connectionId };
        const context = { agendaIds: meeting.agendaId ? [meeting.agendaId] : [], choose: false, tabId, roomCode };
        await chrome.storage.session.set({
            [`${MEETING_TAB_PREFIX}${tabId}`]: binding,
            ...(meeting.agendaId ? { [agendaPanelKey(tabId)]: context, [`agenda-route:${tabId}`]: context } : {}),
        });
        await chrome.alarms.create(`${MEETING_END_PREFIX}${tabId}`, { when: Date.parse(meeting.end) });
        if (meeting.agendaId) await onRoute(tab, context);
        return tab;
    });
}

/** Notification Join creates and binds the tab without attempting a panel open. */
export async function joinMeeting(resolveMeeting, onRoute) {
    const meeting = await resolveMeeting();
    if (!meetCode(meeting?.joinUrl) || !validBinding(meeting, await getSettings()))
        throw new Error("Meeting unavailable");
    const tab = await chrome.tabs.create({ url: meeting.joinUrl });
    return publishJoinedMeeting(meeting, tab.id, onRoute);
}
