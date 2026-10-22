"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onTasksChanged } from "@/components/tasks/task-api";
import {
    onItemProcessingInvalidated,
    recentItemProcessingInvalidation,
} from "@/lib/pipeline/item-processing-events";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import { deriveWorkflowStatus } from "@/lib/pipeline/workflow-status";
import { withRecordingView } from "@/lib/sharing/view";

interface UseItemProcessingOptions {
    itemId: string;
    kind: "audio" | "mail";
    view?: "private" | "org";
    initialData?: ItemProcessingPresentation | null;
    enabled?: boolean;
}

/** Refresh one visible item's projection at the server's deadline, on focus and after local writes. */
export function useItemProcessing({
    itemId,
    kind,
    view = "private",
    initialData,
    enabled = true,
}: UseItemProcessingOptions) {
    const key = `${kind}:${view}:${itemId}`;
    const currentKey = useRef(key);
    const versionRef = useRef(0);
    if (currentKey.current !== key) versionRef.current++;
    currentKey.current = key;
    const version = versionRef.current;
    const [data, setData] = useState<ItemProcessingPresentation | null>(
        initialData ?? null,
    );
    const [failures, setFailures] = useState(0);
    const [nextCheckAt, setNextCheckAt] = useState(
        () =>
            initialData?.nextCheckAt ??
            new Date(Date.now() + 60_000).toISOString(),
    );
    const [pageVisible, setPageVisible] = useState(
        () =>
            typeof document === "undefined" ||
            document.visibilityState === "visible",
    );
    const previousKey = useRef(key);
    const inFlight = useRef<{
        key: string;
        version: number;
        request: Promise<void>;
    } | null>(null);
    const initialized = useRef<string | null>(null);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    useEffect(() => {
        setData(initialData?.itemId === itemId ? initialData : null);
        if (initialData?.nextCheckAt) setNextCheckAt(initialData.nextCheckAt);
        if (previousKey.current === key) return;
        previousKey.current = key;
        setFailures(0);
        setNextCheckAt(
            initialData?.nextCheckAt ??
                new Date(Date.now() + 60_000).toISOString(),
        );
    }, [initialData, itemId, key]);

    const refresh = useCallback((): Promise<void> => {
        if (
            !mounted.current ||
            !enabled ||
            document.visibilityState !== "visible"
        )
            return Promise.resolve();
        if (
            inFlight.current?.key === key &&
            inFlight.current.version === version
        )
            return inFlight.current.request;
        const request = (async () => {
            const path =
                kind === "mail"
                    ? `/api/mail/${encodeURIComponent(itemId)}`
                    : `/api/recordings/${encodeURIComponent(itemId)}?processing=1`;
            try {
                const response = await fetch(withRecordingView(path, view));
                if (!response.ok) throw new Error(String(response.status));
                const body = (await response.json()) as {
                    processing?: ItemProcessingPresentation | null;
                };
                if (
                    !body.processing ||
                    body.processing.itemId !== itemId ||
                    !Number.isFinite(Date.parse(body.processing.nextCheckAt))
                )
                    throw new Error("Invalid processing response");
                if (
                    !mounted.current ||
                    currentKey.current !== key ||
                    versionRef.current !== version
                )
                    return;
                setData(body.processing);
                setFailures(0);
                setNextCheckAt(body.processing.nextCheckAt);
            } catch {
                if (
                    !mounted.current ||
                    currentKey.current !== key ||
                    versionRef.current !== version
                )
                    return;
                setFailures((count) => count + 1);
                setNextCheckAt(new Date(Date.now() + 5_000).toISOString());
            } finally {
                if (
                    inFlight.current?.key === key &&
                    inFlight.current.version === version
                )
                    inFlight.current = null;
            }
        })();
        inFlight.current = { key, version, request };
        return request;
    }, [enabled, itemId, key, kind, version, view]);

    useEffect(() => {
        if (!enabled || !pageVisible || initialized.current === key) return;
        initialized.current = key;
        if (
            initialData === undefined ||
            recentItemProcessingInvalidation(itemId) !== null
        )
            void refresh();
    }, [enabled, initialData, itemId, key, pageVisible, refresh]);

    useEffect(() => {
        const onFocus = () => {
            void refresh();
        };
        const onVisibility = () => {
            const visible = document.visibilityState === "visible";
            setPageVisible(visible);
            if (visible) void refresh();
        };
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            window.removeEventListener("focus", onFocus);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [refresh]);

    useEffect(() => {
        if (!enabled || !pageVisible) return;
        const delay = Math.max(1_000, Date.parse(nextCheckAt) - Date.now());
        const timer = window.setTimeout(() => {
            void refresh();
        }, delay);
        return () => window.clearTimeout(timer);
    }, [enabled, nextCheckAt, pageVisible, refresh]);

    const invalidationWaiting = useRef<Promise<void> | null>(null);
    const refreshAfterChange = useCallback(() => {
        const pending = inFlight.current;
        if (pending?.key !== key || pending.version !== version) {
            void refresh();
            return;
        }
        if (invalidationWaiting.current === pending.request) return;
        invalidationWaiting.current = pending.request;
        void pending.request.then(() => {
            if (invalidationWaiting.current === pending.request)
                invalidationWaiting.current = null;
            if (currentKey.current === key && versionRef.current === version)
                void refresh();
        });
    }, [key, refresh, version]);
    useEffect(
        () => onItemProcessingInvalidated(itemId, refreshAfterChange),
        [itemId, refreshAfterChange],
    );
    useEffect(() => onTasksChanged(refreshAfterChange), [refreshAfterChange]);
    const workflow = useMemo(
        () => (data ? deriveWorkflowStatus(data, kind) : null),
        [data, kind],
    );
    return { data, setData, workflow, refresh, stale: failures >= 2 };
}
