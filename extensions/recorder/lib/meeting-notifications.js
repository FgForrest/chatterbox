let pending = Promise.resolve();

/** Serialize occurrence claims across Calendar and fallback agenda notifications. */
export function claimMeetingNotification(settings, meeting) {
    const work = pending.catch(() => {}).then(async () => {
        const occurrence = meeting.calendarEventId ?? meeting.eventId ?? `agenda:${meeting.id}`;
        const keys = [`${settings.connectionId}:${occurrence}:${Date.parse(meeting.start)}`];
        if (meeting.agendaId) keys.push(`${settings.connectionId}:agenda:${meeting.agendaId}:${Date.parse(meeting.start)}`);
        const stored = (await chrome.storage.local.get("recorderMeetingNotified")).recorderMeetingNotified ?? {};
        if (keys.some((key) => stored[key])) return false;
        for (const [id, at] of Object.entries(stored)) if (Date.now() - at > 2 * 86400000) delete stored[id];
        for (const key of keys) stored[key] = Date.now();
        await chrome.storage.local.set({ recorderMeetingNotified: stored });
        return true;
    });
    pending = work;
    return work;
}
