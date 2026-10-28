"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";

let nativePathname: string | null = null;
const dashboardPathnames = new Set<string>();

/** Mark a native dashboard URL change that Next has not rendered. */
export function noteDashboardUrlChange() {
    nativePathname = window.location.pathname;
    dashboardPathnames.add(nativePathname);
}

/** Reconcile native selection without scrolling, then refresh page and layout data. */
export function useDashboardRefresh() {
    const router = useRouter();
    useEffect(() => {
        const onPopState = () => {
            if (dashboardPathnames.has(window.location.pathname))
                noteDashboardUrlChange();
        };
        window.addEventListener("popstate", onPopState);
        return () => window.removeEventListener("popstate", onPopState);
    }, []);
    return useCallback(() => {
        const { pathname, search } = window.location;
        if (nativePathname === pathname) {
            router.replace(`${pathname}${search}`, { scroll: false });
            nativePathname = null;
        }
        router.refresh();
    }, [router]);
}
