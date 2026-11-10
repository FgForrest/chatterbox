import { t } from "./i18n.js";

/** Format meeting dates, optionally using relative days around the supplied time. */
export function formatMeetingTime(start, end, now) {
    const locale = chrome.i18n.getUILanguage?.() || "en";
    const first = new Date(start);
    const last = end ? new Date(end) : null;
    const date = (value) => {
        if (now !== undefined) {
            for (const [offset, key] of [[0, "agendaToday"], [-1, "agendaYesterday"], [1, "agendaTomorrow"]]) {
                const day = new Date(now);
                day.setDate(day.getDate() + offset);
                if (value.toDateString() === day.toDateString()) return t(key);
            }
        }
        return value.toLocaleDateString(locale, { day: "numeric", month: "numeric" });
    };
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
