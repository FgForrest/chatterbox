"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { TIME_ZONE_COOKIE, timeZoneFromCookie } from "@/lib/i18n/time-zone";

/** Persist the browser zone after hydration and refresh when it changes. */
export function ViewerTimeZone() {
    const router = useRouter();
    useEffect(() => {
        const sync = () => {
            const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            if (!zone) return;
            const cookie = document.cookie
                .split("; ")
                .find((entry) => entry.startsWith(`${TIME_ZONE_COOKIE}=`))
                ?.slice(TIME_ZONE_COOKIE.length + 1);
            if (cookie === encodeURIComponent(timeZoneFromCookie(zone))) return;
            // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store is unavailable in supported older browsers.
            document.cookie = `${TIME_ZONE_COOKIE}=${encodeURIComponent(zone)}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
            const stored = document.cookie
                .split("; ")
                .find((entry) => entry.startsWith(`${TIME_ZONE_COOKIE}=`))
                ?.slice(TIME_ZONE_COOKIE.length + 1);
            if (stored === encodeURIComponent(zone)) router.refresh();
        };
        sync();
        window.addEventListener("focus", sync);
        return () => window.removeEventListener("focus", sync);
    }, [router]);
    return null;
}
