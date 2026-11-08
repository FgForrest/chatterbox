import {
    cachedNextMeeting,
    NEXT_MEETING_KEY,
    roomIsOpen,
} from "./next-meeting.js";
import { t } from "./i18n.js";
import { formatMeetingTime } from "./meeting-time.js";

/** Render the same Calendar offer in popup and agenda panel. */
export function createNextMeetingCard(container, tab) {
    let disposed = false;
    async function render() {
        const meeting = (await cachedNextMeeting())?.data;
        if (disposed) return;
        container.hidden =
            !meeting ||
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
        join.addEventListener(
            "click",
            () => void chrome.tabs.create({ url: meeting.joinUrl }),
        );
        container.replaceChildren(heading, title, time, join, account);
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
