import { pairingRequest } from "./pairing-request-auth.js";
import { scheduleAgendaReminders } from "./agendas.js";
import { formatMeetingTime } from "./meeting-time.js";
import { claimMeetingNotification } from "./meeting-notifications.js";
import { t } from "./i18n.js";
import { getSettings } from "./settings.js";
import { meetCode } from "./meet-code.js";

export const NEXT_MEETING_KEY = "recorderNextMeeting";
export const NEXT_REFRESH = "recorder-next-refresh";
export const NEXT_START = "recorder-next-start";
export const NEXT_BADGE = "recorder-next-badge";
export const NEXT_END = "recorder-next-end";
export const NEXT_NOTICE = "meeting:";

/** New Calendar requests require explicit server support and extension consent. */
export function supportsNextMeeting(settings) {
    return Boolean(
        settings.dataUseAcknowledgedAt &&
            settings.serverUrl &&
            settings.hasApiKey &&
            settings.serverDefaults?.nextMeeting === true,
    );
}

/** Extract only validated Meet room URLs, preserving the server's authuser selection. */
export function meetingRoom(url) {
    const code = meetCode(url);
    return code ? `/${code}` : null;
}

/** Hide meeting offers when the user already has the room open. */
export function roomIsOpen(meeting, tabs) {
    const room = meetingRoom(meeting?.joinUrl);
    return Boolean(room && tabs.some((tab) => meetingRoom(tab.url) === room));
}

/** Read only the current pairing's transient Calendar cache. */
export async function cachedNextMeeting() {
    const settings = await getSettings();
    if (!supportsNextMeeting(settings)) return null;
    const cached = (await chrome.storage.session.get(NEXT_MEETING_KEY))[
        NEXT_MEETING_KEY
    ];
    return supportsNextMeeting(settings) &&
        cached?.serverUrl === settings.serverUrl &&
        cached.connectionId === settings.connectionId
        ? cached
        : null;
}

let refreshing;
/** Refresh on an alarm or page open; concurrent pages share the same request. */
export function refreshNextMeeting({ opened = false } = {}) {
    refreshing ??= refreshNow(opened).finally(() => {
        refreshing = undefined;
    });
    return refreshing;
}

async function refreshNow(opened) {
    const settings = await getSettings();
    if (!supportsNextMeeting(settings)) {
        await clearNextMeeting();
        return null;
    }
    const cached = await cachedNextMeeting();
    if (cached && Date.now() - cached.fetchedAt < (opened ? 60000 : 300000)) {
        await scheduleNextMeeting(cached.data);
        return cached;
    }
    let data = null;
    let reason;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await pairingRequest(
            "/api/v1/recorder/meetings/next",
            { signal: controller.signal },
            supportsNextMeeting,
            settings,
        );
        const body = await response.json();
        data =
            body.data &&
            meetingRoom(body.data.joinUrl) &&
            new URL(body.data.joinUrl).searchParams.get("authuser") ===
                body.data.accountEmail
                ? body.data
                : null;
        reason = body.reason;
    } catch {
        reason = "calendar_unavailable";
    } finally {
        clearTimeout(timer);
    }
    const latest = await getSettings();
    if (
        !supportsNextMeeting(latest) ||
        latest.serverUrl !== settings.serverUrl ||
        latest.connectionId !== settings.connectionId
    )
        return null;
    const value = {
        serverUrl: settings.serverUrl,
        connectionId: settings.connectionId,
        fetchedAt: Date.now(),
        data,
        reason,
    };
    await chrome.storage.session.set({ [NEXT_MEETING_KEY]: value });
    await scheduleAgendaReminders();
    await scheduleNextMeeting(data);
    return value;
}

/** Replace stale alarms after calendar or notification settings change. */
export async function scheduleNextMeeting(meeting) {
    await Promise.all([
        chrome.alarms.clear(NEXT_START),
        chrome.alarms.clear(NEXT_END),
        chrome.alarms.clear(NEXT_BADGE),
    ]);
    if (!meeting || Date.parse(meeting.end) <= Date.now()) {
        await updateNextMeetingBadge();
        return;
    }
    const settings = await getSettings();
    if (Date.parse(meeting.start) > Date.now())
        await chrome.alarms.create(NEXT_BADGE, {
            when: Date.parse(meeting.start),
        });
    const when =
        Date.parse(meeting.start) - settings.meetingLeadMinutes * 60000;
    if (settings.meetingNotifications && when > Date.now())
        await chrome.alarms.create(NEXT_START, { when });
    else if (settings.meetingNotifications) await notifyNextMeeting();
    await chrome.alarms.create(NEXT_END, { when: Date.parse(meeting.end) });
    await updateNextMeetingBadge();
}

/** Show one Calendar notification per occurrence, never initiating capture. */
export function notifyNextMeeting() {
    const work = notifying.catch(() => {}).then(notifyNextMeetingNow);
    notifying = work;
    return work;
}

let notifying = Promise.resolve();
async function notifyNextMeetingNow() {
    const settings = await getSettings();
    const meeting = (await cachedNextMeeting())?.data;
    if (
        !settings.meetingNotifications ||
        !meeting ||
        Date.parse(meeting.end) <= Date.now()
    )
        return;
    const due = Date.parse(meeting.start) - settings.meetingLeadMinutes * 60000;
    if (due > Date.now()) return;
    if (!await claimMeetingNotification(settings, meeting)) return;
    if (roomIsOpen(meeting, await chrome.tabs.query({}))) return;
    const id = `${NEXT_NOTICE}${encodeURIComponent(meeting.eventId)}`;
    await chrome.storage.session.set({
        [id]: {
            ...meeting,
            serverUrl: settings.serverUrl,
            connectionId: settings.connectionId,
        },
    });
    await chrome.notifications.create(id, {
        type: "basic",
        iconUrl: "icons/icon-128.png",
        title: meeting.title,
        message: t(
            "nextMeetingStarts",
            formatMeetingTime(meeting.start, meeting.end),
        ),
        buttons: [
            { title: t("joinMeet") },
            ...(meeting.agendaId ? [{ title: t("agendaShow") }] : []),
        ],
    });
}

/** Resolve notification destinations against the current pairing. */
export async function notificationMeeting(id) {
    const settings = await getSettings();
    const meeting = (await chrome.storage.session.get(id))[id];
    return supportsNextMeeting(settings) &&
        meeting?.serverUrl === settings.serverUrl &&
        meeting.connectionId === settings.connectionId &&
        meetingRoom(meeting.joinUrl) &&
        Date.parse(meeting.end) > Date.now()
        ? meeting
        : null;
}

/** REC has priority; Calendar supplies only an ongoing 'now' badge. */
export async function updateNextMeetingBadge() {
    if (!supportsNextMeeting(await getSettings())) return;
    const meeting = (await cachedNextMeeting())?.data;
    const state =
        (await chrome.storage.session.get("recordingState")).recordingState ??
        {};
    const recording = ["recording", "finalizing"].includes(state.state);
    const running =
        meeting &&
        Date.parse(meeting.start) <= Date.now() &&
        Date.parse(meeting.end) > Date.now();
    const text = recording
        ? "REC"
        : running && !roomIsOpen(meeting, await chrome.tabs.query({}))
          ? t("meetingNow")
          : "";
    const previous =
        (await chrome.storage.session.get("recorderNextBadge"))
            .recorderNextBadge ?? [];
    const tabs = await chrome.tabs.query({});
    await chrome.action.setBadgeText({ text });
    if (text)
        await chrome.action.setBadgeBackgroundColor({
            color: recording ? "#dd3333" : "#23766e",
        });
    for (const tab of tabs)
        if (text || previous.includes(tab.id)) {
            await chrome.action.setBadgeText({ tabId: tab.id, text });
            if (text)
                await chrome.action.setBadgeBackgroundColor({
                    tabId: tab.id,
                    color: recording ? "#dd3333" : "#23766e",
                });
        }
    await chrome.storage.session.set({
        recorderNextBadge: text ? tabs.map((tab) => tab.id) : [],
    });
}

/** Remove transient Calendar data when consent or the pairing disappears. */
export async function clearNextMeeting() {
    const stored = await chrome.storage.session.get(null);
    if (stored.recorderNextBadge?.length) {
        await chrome.action.setBadgeText({ text: "" });
        for (const tabId of stored.recorderNextBadge)
            await chrome.action
                .setBadgeText({
                    tabId,
                    text:
                        ["recording", "finalizing"].includes(
                            stored.recordingState?.state,
                        ) && stored.recordingState.tabId === tabId
                            ? "REC"
                            : "",
                })
                .catch(() => {});
        await chrome.storage.session.remove("recorderNextBadge");
    }
    await chrome.storage.session.remove([
        NEXT_MEETING_KEY,
        ...Object.keys(stored).filter((key) => key.startsWith(NEXT_NOTICE)),
    ]);
    await Promise.all([
        chrome.alarms.clear(NEXT_START),
        chrome.alarms.clear(NEXT_END),
        chrome.alarms.clear(NEXT_BADGE),
    ]);
    for (const id of Object.keys((await chrome.notifications.getAll?.()) ?? {}))
        if (id.startsWith(NEXT_NOTICE)) await chrome.notifications.clear(id);
    await updateNextMeetingBadge();
}
