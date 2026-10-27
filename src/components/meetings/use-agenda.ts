"use client";

import { useExtracted } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { meetingRequest, meetingUrl, takePrewarmedAgenda } from "./api";
import type { MeetingDetail } from "./types";

export function useAgenda(id: string, initial?: MeetingDetail, active = true) {
    const i18n = useExtracted();
    const [detail, setDetail] = useState<MeetingDetail | null>(initial ?? null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(0);
    const [colleagueChange, setColleagueChange] = useState(false);
    const current = useRef(detail);
    const revision = useRef(0);
    const outstanding = useRef(0);
    const base = useRef(detail);
    const overlays = useRef<
        { token: object; apply: (value: MeetingDetail) => MeetingDetail }[]
    >([]);
    const mounted = useRef(true);
    const seeded = useRef(Boolean(initial));
    const queue = useRef(Promise.resolve());
    current.current = detail;
    const reload = useCallback(
        async (signal?: AbortSignal, poll = false) => {
            const before = revision.current;
            if (outstanding.current) return;
            const cursor =
                poll && current.current
                    ? `?since=${current.current.version}`
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
        },
        [id],
    );
    useEffect(() => {
        mounted.current = true;
        const controller = new AbortController();
        if (active && seeded.current) seeded.current = false;
        else if (active)
            void reload(controller.signal).catch((err: Error) => {
                if (!controller.signal.aborted) setError(err.message);
            });
        const poll = () => {
            if (active && document.visibilityState === "visible")
                void reload(controller.signal, true).catch(() => {});
        };
        const timer = setInterval(poll, 15000);
        document.addEventListener("visibilitychange", poll);
        return () => {
            mounted.current = false;
            controller.abort();
            clearInterval(timer);
            document.removeEventListener("visibilitychange", poll);
        };
    }, [active, reload]);
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
            overlays.current.push({ token, apply: optimistic });
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
                } catch (err) {
                    if (mounted.current)
                        toast.error(
                            err instanceof Error
                                ? err.message
                                : i18n("Could not save the agenda"),
                        );
                }
                try {
                    const next = await meetingRequest<
                        MeetingDetail | { unchanged: true; version: number }
                    >(
                        meetingUrl(
                            id,
                            base.current
                                ? `?since=${base.current.version}`
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
        colleagueChange,
        dismissChange: () => setColleagueChange(false),
        reload,
        mutate,
    };
}
export type AgendaController = ReturnType<typeof useAgenda>;
