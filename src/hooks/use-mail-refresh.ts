"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";

const MAIL_REFRESH_INTERVAL_MS = 60_000;

/** Refresh server-rendered dashboard data when newly accepted mail appears. */
export function useMailRefresh(
    enabled: boolean,
    interval = MAIL_REFRESH_INTERVAL_MS,
): void {
    const router = useRouter();
    const versionRef = useRef<string | null | undefined>(undefined);
    const lastCheckedAtRef = useRef<number | null>(null);
    const checkingRef = useRef(false);

    const check = useCallback(async () => {
        if (!enabled || document.visibilityState !== "visible") return;
        const now = Date.now();
        if (
            checkingRef.current ||
            (lastCheckedAtRef.current !== null &&
                now - lastCheckedAtRef.current < interval)
        ) {
            return;
        }
        checkingRef.current = true;
        lastCheckedAtRef.current = now;
        try {
            const response = await fetch("/api/mail/status");
            if (!response.ok) return;
            const { version } = (await response.json()) as {
                version: string | null;
            };
            if (versionRef.current === undefined) {
                versionRef.current = version;
                return;
            }
            if (versionRef.current !== version) {
                versionRef.current = version;
                router.refresh();
            }
        } finally {
            checkingRef.current = false;
        }
    }, [enabled, interval, router]);

    useEffect(() => {
        if (!enabled) return;
        void check();
        const timer = setInterval(() => void check(), interval);
        const handleVisibilityChange = () => void check();
        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => {
            clearInterval(timer);
            document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange,
            );
        };
    }, [check, enabled, interval]);
}
