"use client";

import { useTimeZone } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import type { StatisticsData, StatisticsScope } from "@/lib/statistics/data";

export function useStatisticsData(initialData: StatisticsData) {
    const timeZone = useTimeZone() ?? "UTC";
    const [data, setData] = useState(initialData);
    const [scope, setScope] = useState(initialData.scope);
    const [loading, setLoading] = useState(false);
    const [failed, setFailed] = useState(false);
    const cache = useRef(
        new Map<string, Promise<StatisticsData>>([
            [
                `${initialData.tz}:${initialData.scope}`,
                Promise.resolve(initialData),
            ],
        ]),
    );
    const zone = useRef(initialData.tz);
    const requested = useRef(0);
    const wantedScope = useRef(initialData.scope);
    const mounted = useRef(true);
    const fetchScope = useCallback((next: StatisticsScope, tz: string) => {
        const key = `${tz}:${next}`;
        const cached = cache.current.get(key);
        if (cached) return cached;
        const promise = fetch(
            `/api/statistics?scope=${next}&tz=${encodeURIComponent(tz)}`,
        )
            .then(async (response) => {
                if (!response.ok) throw new Error("Statistics request failed");
                return response.json() as Promise<StatisticsData>;
            })
            .catch((error: unknown) => {
                cache.current.delete(key);
                throw error;
            });
        cache.current.set(key, promise);
        return promise;
    }, []);
    const selectScope = useCallback(
        async (next: StatisticsScope, tz = zone.current) => {
            const version = ++requested.current;
            wantedScope.current = next;
            setScope(next);
            setLoading(true);
            setFailed(false);
            try {
                const result = await fetchScope(next, tz);
                if (mounted.current && requested.current === version) {
                    setData(result);
                    setLoading(false);
                }
            } catch {
                if (mounted.current && requested.current === version) {
                    setLoading(false);
                    setFailed(true);
                }
            }
        },
        [fetchScope],
    );
    useEffect(() => {
        mounted.current = true;
        if (zone.current !== timeZone) {
            zone.current = timeZone;
            void selectScope(wantedScope.current, timeZone);
        }
        return () => {
            mounted.current = false;
        };
    }, [timeZone, selectScope]);

    const warmScope = (next: StatisticsScope) => {
        void fetchScope(next, zone.current).catch(() => undefined);
    };
    return { data, scope, loading, failed, selectScope, warmScope };
}
