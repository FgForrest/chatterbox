"use client";

import { useEffect } from "react";
import { getAppHistoryState } from "@/lib/history-state";

/** Expose the visible recorder setup to the extension without adding history. */
export function useRecorderSetupMarker(visible: boolean) {
    useEffect(() => {
        if (!visible) return;
        const url = new URL(window.location.href);
        const previous = url.searchParams.get("section");
        url.searchParams.set("section", "recorder");
        window.history.replaceState(getAppHistoryState(), "", url);
        return () => {
            const current = new URL(window.location.href);
            if (current.searchParams.get("section") !== "recorder") return;
            if (previous && previous !== "recorder") {
                current.searchParams.set("section", previous);
            } else {
                current.searchParams.delete("section");
            }
            window.history.replaceState(getAppHistoryState(), "", current);
        };
    }, [visible]);
}
