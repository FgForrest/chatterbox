import { meetCode } from "./meet-code.js";

async function openTabPanel(tabId) {
    try {
        await chrome.sidePanel.setOptions({ tabId, path: `agenda/agenda.html?tab=${tabId}`, enabled: true });
        await chrome.sidePanel.open({ tabId });
        return true;
    } catch {
        return false;
    }
}

/** Keep panel activation in the page; activate a popup's new tab only after opening its panel. */
export async function joinMeetingFromPage(meeting, { popup = false, windowId } = {}) {
    if (!meetCode(meeting?.joinUrl) || !Number.isFinite(Date.parse(meeting.end)) || Date.parse(meeting.end) <= Date.now())
        throw new Error("Meeting unavailable");
    const tab = await chrome.tabs.create({ url: meeting.joinUrl, active: !popup, ...(windowId != null ? { windowId } : {}) });
    const publish = async (fallback = false) => {
        const result = await chrome.runtime.sendMessage({ type: "join-meeting", eventId: meeting.eventId, tabId: tab.id, fallback });
        if (!result?.ok) throw new Error("Meeting unavailable");
    };
    if (popup) await publish();
    const opened = !meeting.agendaId || await openTabPanel(tab.id);
    if (!popup || !opened) await publish(!opened);
    if (popup && opened) await chrome.tabs.update(tab.id, { active: true });
    return tab;
}
