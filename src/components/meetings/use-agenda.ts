"use client";

import { useExtracted } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { meetingRequest, meetingUrl, takePrewarmedAgenda } from "./api";
import type { MeetingDetail } from "./types";

export function useAgenda(
    id: string,
    initial?: MeetingDetail,
    active = true,
    pollEnabled = true,
) {
    const i18n = useExtracted();
    const [detail, setDetail] = useState<MeetingDetail | null>(initial ?? null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(0);
    const [pendingPaths, setPendingPaths] = useState<string[]>([]);
    const [colleagueChange, setColleagueChange] = useState(false);
    const loadError = i18n("Could not load the agenda");
    const loading = useRef(false);
    const [conflict, setConflict] = useState(false);
    const current = useRef(detail);
    const revision = useRef(0);
    const outstanding = useRef(0);
    const base = useRef(detail);
    const overlays = useRef<
        {
            token: object;
            path: string;
            apply: (value: MeetingDetail) => MeetingDetail;
        }[]
    >([]);
    const mounted = useRef(true);
    const seeded = useRef(Boolean(initial));
    const queue = useRef(Promise.resolve());
    current.current = detail;
    const reload = useCallback(
        async (signal?: AbortSignal, poll = false) => {
            const before = revision.current;
            if (outstanding.current || loading.current) return;
            loading.current = true;
            try {
                const cursor =
                    poll && current.current
                        ? `?since=${encodeURIComponent(current.current.cursor ?? String(current.current.version))}`
                        : "";
                const warmed =
                    !poll && !current.current ? takePrewarmedAgenda(id) : null;
                const next = warmed
                    ? await warmed
                    : await meetingRequest<
                          MeetingDetail | { unchanged: true; version: number }
                      >(meetingUrl(id, cursor), "GET", undefined, signal);
                if (
                    before !== revision.current ||
                    signal?.aborted ||
                    next.unchanged
                )
                    return;
                if (
                    poll &&
                    current.current &&
                    next.version !== current.current.version
                )
                    setColleagueChange(true);
                base.current = next;
                current.current = next;
                setDetail(next);
                setError(null);
            } finally {
                loading.current = false;
            }
        },
        [id],
    );
    useEffect(() => {
        mounted.current = true;
        const controller = new AbortController();
        if (active && seeded.current) seeded.current = false;
        else if (active)
            void reload(controller.signal).catch(() => {
                if (!controller.signal.aborted) setError(loadError);
            });
        const poll = () => {
            if (active && pollEnabled && document.visibilityState === "visible")
                void reload(controller.signal, true).catch(() => {});
        };
        const timer = active && pollEnabled ? setInterval(poll, 15000) : null;
        if (timer !== null) document.addEventListener("visibilitychange", poll);
        return () => {
            mounted.current = false;
            controller.abort();
            if (timer !== null) clearInterval(timer);
            document.removeEventListener("visibilitychange", poll);
        };
    }, [active, reload, pollEnabled, loadError]);
    const mutate = useCallback(
        (
            path: string,
            method: string,
            body: unknown | ((value: MeetingDetail) => unknown),
            optimistic: (value: MeetingDetail) => MeetingDetail,
        ) => {
            const token = {};
            revision.current++;
            outstanding.current++;
            overlays.current.push({ token, path, apply: optimistic });
            setPendingPaths(overlays.current.map((entry) => entry.path));
            setPending(outstanding.current);
            setDetail((value) => (value ? optimistic(value) : value));
            const operation = queue.current.then(async () => {
                let saved = false;
                try {
                    const payload =
                        typeof body === "function" && base.current
                            ? body(base.current)
                            : body;
                    await meetingRequest(
                        path.startsWith("/api/") ? path : meetingUrl(id, path),
                        method,
                        payload,
                    );
                    saved = true;
                    if (mounted.current) setConflict(false);
                } catch (err) {
                    if (mounted.current) {
                        const conflicted =
                            err instanceof Error &&
                            "status" in err &&
                            err.status === 409;
                        setConflict(conflicted);
                        toast.error(
                            conflicted
                                ? i18n(
                                      "Someone else changed this agenda. Your input is kept. Review their changes and try again.",
                                  )
                                : i18n("Could not save the agenda"),
                        );
                    }
                }
                try {
                    const next = await meetingRequest<
                        MeetingDetail | { unchanged: true; version: number }
                    >(
                        meetingUrl(
                            id,
                            base.current
                                ? `?since=${encodeURIComponent(base.current.cursor ?? String(base.current.version))}`
                                : "",
                        ),
                    );
                    if (!next.unchanged) base.current = next;
                    else if (saved)
                        base.current = await meetingRequest<MeetingDetail>(
                            meetingUrl(id),
                        );
                } catch {
                    if (saved && base.current)
                        base.current = optimistic(base.current);
                    if (mounted.current)
                        setError(i18n("Could not reload the agenda"));
                }
                overlays.current = overlays.current.filter(
                    (entry) => entry.token !== token,
                );
                outstanding.current--;
                revision.current++;
                if (mounted.current) {
                    setPending(outstanding.current);
                    setPendingPaths(
                        overlays.current.map((entry) => entry.path),
                    );
                    const confirmed = base.current;
                    const next = confirmed
                        ? overlays.current.reduce(
                              (value, entry) => entry.apply(value),
                              confirmed,
                          )
                        : confirmed;
                    current.current = next;
                    setDetail(next);
                }
                return saved;
            });
            queue.current = operation.then(
                () => {},
                () => {},
            );
            return operation;
        },
        [id, i18n],
    );
    return {
        detail,
        error,
        pending,
        pendingPaths,
        colleagueChange,
        conflict,
        dismissChange: () => setColleagueChange(false),
        reload,
        mutate,
    };
}
export type AgendaController = ReturnType<typeof useAgenda>;
