/** Format meeting dates in the extension's UI language with a single date per day. */
export function formatMeetingTime(start, end) {
    const locale = chrome.i18n.getUILanguage?.() || "en";
    const first = new Date(start);
    const last = end ? new Date(end) : null;
    const date = (value) =>
        value.toLocaleDateString(locale, { day: "numeric", month: "numeric" });
    const time = (value) =>
        value.toLocaleTimeString(locale, {
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
        });
    const startTime = `${date(first)} ${time(first)}`;
    if (!last) return startTime;
    const endDate = first.toDateString() === last.toDateString() ? "" : `${date(last)} `;
    return `${startTime}–${endDate}${time(last)}`;
}
