"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { type ConnectionState, subscribeEvents } from "@/lib/events/client";

const FALLBACK_INTERVAL_MS = 60_000;
const CONNECTED_INTERVAL_MS = 5 * 60_000;
const REFRESH_DEBOUNCE_MS = 300;

/** Refresh the dashboard on mail push, with polling as a safety net. */
export function useMailRefresh(enabled: boolean): void {
    const { refresh } = useRouter();
    useEffect(() => {
        if (!enabled) return;
        let version: string | null | undefined;
        let active = true;
        let checking = false;
        let pendingRefresh = false;
        let refreshTimer: ReturnType<typeof setTimeout> | undefined;
        let pollTimer: ReturnType<typeof setInterval> | undefined;
        let pollInterval = 0;
        const abort = new AbortController();

        const scheduleRefresh = () => {
            pendingRefresh = true;
            clearTimeout(refreshTimer);
            if (document.visibilityState !== "visible") return;
            refreshTimer = setTimeout(() => {
                if (!active || document.visibilityState !== "visible") return;
                pendingRefresh = false;
                refresh();
            }, REFRESH_DEBOUNCE_MS);
        };
        const check = async () => {
            if (!active || checking || document.visibilityState !== "visible")
                return;
            checking = true;
            try {
                const response = await fetch("/api/mail/status", {
                    signal: abort.signal,
                });
                if (!response.ok || !active) return;
                const data: unknown = await response.json();
                if (
                    !active ||
                    !data ||
                    typeof data !== "object" ||
                    !("version" in data) ||
                    (data.version !== null && typeof data.version !== "string")
                )
                    return;
                if (version !== undefined && version !== data.version)
                    scheduleRefresh();
                version = data.version;
            } catch {
            } finally {
                checking = false;
            }
        };
        const onState = (state: ConnectionState) => {
            const interval =
                state === "open" ? CONNECTED_INTERVAL_MS : FALLBACK_INTERVAL_MS;
            if (interval !== pollInterval) {
                pollInterval = interval;
                clearInterval(pollTimer);
                pollTimer = setInterval(() => void check(), interval);
            }
            if (state === "open") void check();
        };
        const unsubscribe = subscribeEvents((event) => {
            if (event.type === "mail") scheduleRefresh();
        }, onState);
        void check();
        const onVisibility = () => {
            if (document.visibilityState !== "visible") return;
            if (pendingRefresh) scheduleRefresh();
            void check();
        };
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            active = false;
            abort.abort();
            unsubscribe();
            clearInterval(pollTimer);
            clearTimeout(refreshTimer);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [enabled, refresh]);
}
