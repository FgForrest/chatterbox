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
    const absoluteSeconds = Math.abs(difference) / 1000;
    let unit: Intl.RelativeTimeFormatUnit = "second";
    let divisor = 1000;
    if (absoluteSeconds >= 86_400) {
        unit = "day";
        divisor = 86_400_000;
    } else if (absoluteSeconds >= 3_600) {
        unit = "hour";
        divisor = 3_600_000;
    } else if (absoluteSeconds >= 60) {
        unit = "minute";
        divisor = 60_000;
    }
    const value = Math.round(difference / divisor);
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
