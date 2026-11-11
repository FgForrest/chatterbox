import {
    cachedNextMeeting,
    NEXT_MEETING_KEY,
    roomIsOpen,
} from "./next-meeting.js";
import { joinMeetingFromPage } from "./join-meeting-page.js";
import { t } from "./i18n.js";
import { formatMeetingTime } from "./meeting-time.js";

/** Render the same Calendar offer in popup and agenda panel. */
export function createNextMeetingCard(container, tab, { state = () => ({}), agendaId, compact = false, popup = false } = {}) {
    let disposed = false;
    async function render() {
        if (disposed) return;
        const meeting = (await cachedNextMeeting())?.data;
        if (disposed) return;
        container.hidden =
            !meeting ||
            (state().state && state().state !== "idle") ||
            (agendaId && meeting.agendaId !== agendaId()) ||
            Date.parse(meeting.end) <= Date.now() ||
            roomIsOpen(meeting, [tab() ?? {}]);
        if (container.hidden) return;
        const heading = document.createElement("p");
        heading.className = "hint";
        heading.textContent = t("nextMeeting");
        const title = document.createElement("strong");
        title.textContent = meeting.title;
        const time = document.createElement("p");
        time.className = "hint";
        time.textContent = formatMeetingTime(meeting.start, meeting.end);
        const account = document.createElement("p");
        account.className = "hint";
        account.textContent = t("joinMeetAccount", meeting.accountEmail);
        const join = document.createElement("button");
        join.type = "button";
        join.textContent = t("joinMeet");
        join.className = "join-meet";
        join.addEventListener("click", () => {
            join.disabled = true;
            void joinMeetingFromPage(meeting, { popup, windowId: tab()?.windowId })
                .catch(() => { account.textContent = t("agendaFailed"); })
                .finally(() => { join.disabled = false; });
        });
        if (compact) container.replaceChildren(join, account);
        else container.replaceChildren(heading, title, time, join, account);
    }
    const changed = (changes, area) => {
        if (area === "session" && changes[NEXT_MEETING_KEY]) void render();
    };
    chrome.storage.onChanged.addListener(changed);
    const timer = setInterval(() => void render(), 30000);
    void chrome.runtime
        .sendMessage({ type: "next-meeting-opened" })
        .then(render)
        .catch(() => {});
    return {
        render,
        destroy: () => {
            disposed = true;
            clearInterval(timer);
            chrome.storage.onChanged.removeListener(changed);
        },
    };
}
