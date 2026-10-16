import {
    differenceInDays,
    format,
    formatDistanceToNow,
    isThisYear,
    isToday,
    isYesterday,
} from "date-fns";
import { cs, enUS } from "date-fns/locale";
import type { DateTimeFormat } from "@/types/common";

export type { DateTimeFormat };

function dateLocale(locale: string) {
    return locale.toLowerCase().startsWith("cs") ? cs : enUS;
}

export function formatDateTime(
    date: Date | string,
    formatType: DateTimeFormat = "relative",
    locale = "en",
): string {
    const dateObj = typeof date === "string" ? new Date(date) : date;
    const resolvedLocale = dateLocale(locale);

    switch (formatType) {
        case "relative":
            return formatDistanceToNow(dateObj, {
                addSuffix: true,
                locale: resolvedLocale,
            });
        case "absolute":
            return format(
                dateObj,
                locale.toLowerCase().startsWith("cs")
                    ? "d. M. yyyy H:mm"
                    : "MMM d, yyyy h:mm a",
                { locale: resolvedLocale },
            );
        case "iso":
            return dateObj.toISOString();
        default:
            return formatDistanceToNow(dateObj, {
                addSuffix: true,
                locale: resolvedLocale,
            });
    }
}

/** Short localized relative time for compact status surfaces. */
export function formatCompactRelativeTime(
    date: Date,
    locale = "en",
    now = Date.now(),
): string {
    const difference = date.getTime() - now;
    const absolute = Math.abs(difference);
    const sign = difference < 0 ? -1 : 1;
    let unit: Intl.RelativeTimeFormatUnit = "day";
    let magnitude = Math.round(absolute / 86_400_000);
    const seconds = Math.round(absolute / 1000);
    const minutes = Math.round(absolute / 60_000);
    const hours = Math.round(absolute / 3_600_000);
    if (seconds < 60) {
        unit = "second";
        magnitude = seconds;
    } else if (minutes < 60) {
        unit = "minute";
        magnitude = minutes;
    } else if (hours < 24) {
        unit = "hour";
        magnitude = hours;
    }
    const value = sign * magnitude;
    return new Intl.RelativeTimeFormat(locale, {
        numeric: "auto",
        style: "short",
    }).format(value, unit);
}

export interface DateGroupLabels {
    today: string;
    yesterday: string;
    thisWeek: string;
    earlierThisMonth: string;
}

/** Recording-list group label: Today / Yesterday / This week / month / Month YYYY. */
export function dateGroupLabel(
    date: Date | string,
    labels: DateGroupLabels,
    locale = "en",
): string {
    const d = typeof date === "string" ? new Date(date) : date;
    if (isToday(d)) return labels.today;
    if (isYesterday(d)) return labels.yesterday;
    const now = new Date();
    const days = differenceInDays(now, d);
    if (days >= 0 && days < 7) return labels.thisWeek;
    if (
        d.getMonth() === now.getMonth() &&
        d.getFullYear() === now.getFullYear()
    ) {
        return labels.earlierThisMonth;
    }
    const options = { locale: dateLocale(locale) };
    return isThisYear(d)
        ? format(d, "LLLL", options)
        : format(d, "LLLL yyyy", options);
}
