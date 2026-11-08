"use client";

import { useExtracted, useFormatter } from "next-intl";

export function AgendaAttribution({
    name,
    at,
}: {
    name?: string | null;
    at?: string | null;
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    return (
        <p className="ml-7 h-4 truncate text-xs text-muted-foreground">
            {name &&
                at &&
                i18n("Changed by {name} at {time}", {
                    name,
                    time: format.dateTime(new Date(at), {
                        hour: "2-digit",
                        minute: "2-digit",
                    }),
                })}
        </p>
    );
}
