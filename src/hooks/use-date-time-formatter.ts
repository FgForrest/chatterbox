"use client";

import { useTimeZone } from "use-intl/react";
import { formatDateTime } from "@/lib/format-date";
import type { DateTimeFormat } from "@/types/common";

/** Bind custom relative/absolute/ISO formatting to the request's resolved zone. */
export function useDateTimeFormatter() {
    const timeZone = useTimeZone() ?? "UTC";
    return (
        date: Date | string,
        format: DateTimeFormat = "relative",
        locale = "en",
    ) => formatDateTime(date, format, locale, timeZone);
}
