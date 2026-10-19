"use client";

import { useEffect, useRef } from "react";
import { subscribeEvents } from "@/lib/events/client";
import type { OrgClientEvent } from "@/lib/events/types";

/** Follow Organization changes through the tab's shared event stream. */
export function useOrgEvents(
    enabled: boolean,
    onEvent: (event: OrgClientEvent) => void,
): void {
    const onEventRef = useRef(onEvent);
    onEventRef.current = onEvent;
    useEffect(() => {
        if (!enabled) return;
        return subscribeEvents((event) => {
            if (event.type !== "mail") onEventRef.current(event);
        });
    }, [enabled]);
}
