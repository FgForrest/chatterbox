"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onTasksChanged } from "@/components/tasks/task-api";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import { deriveWorkflowStatus } from "@/lib/pipeline/workflow-status";

interface UseItemProcessingOptions {
    itemId: string;
    kind: "audio" | "mail";
    initialData?: ItemProcessingPresentation | null;
    enabled?: boolean;
}

/** Own one item's processing projection and refresh it only while work is active. */
export function useItemProcessing({
    itemId,
    kind,
    initialData,
    enabled = true,
}: UseItemProcessingOptions) {
    const [data, setData] = useState<ItemProcessingPresentation | null>(
        initialData ?? null,
    );
    const [pageVisible, setPageVisible] = useState(
        typeof document === "undefined" ||
            document.visibilityState === "visible",
    );
    const currentItemId = useRef(itemId);
    currentItemId.current = itemId;

    useEffect(() => {
        setData(initialData?.itemId === itemId ? initialData : null);
    }, [initialData, itemId]);

    const refresh = useCallback(async () => {
        if (!enabled) return;
        const url =
            kind === "mail"
                ? `/api/mail/${encodeURIComponent(itemId)}`
                : `/api/recordings/${encodeURIComponent(itemId)}?processing=1`;
        try {
            const response = await fetch(url);
            if (!response.ok) return;
            const body = (await response.json()) as {
                processing?: ItemProcessingPresentation | null;
            };
            if (currentItemId.current === itemId) {
                setData(body.processing ?? null);
            }
        } catch {}
    }, [enabled, itemId, kind]);

    useEffect(() => {
        if (enabled && initialData === undefined) void refresh();
    }, [enabled, initialData, refresh]);

    const workflow = useMemo(
        () => (data ? deriveWorkflowStatus(data, kind) : null),
        [data, kind],
    );
    const active =
        workflow?.steps.some(
            (step) => step.state === "queued" || step.state === "working",
        ) ?? false;

    useEffect(() => {
        const onVisibility = () =>
            setPageVisible(document.visibilityState === "visible");
        document.addEventListener("visibilitychange", onVisibility);
        return () =>
            document.removeEventListener("visibilitychange", onVisibility);
    }, []);

    useEffect(() => {
        if (!enabled || !active || !pageVisible) return;
        const timer = window.setInterval(() => void refresh(), 5_000);
        const onFocus = () => void refresh();
        window.addEventListener("focus", onFocus);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener("focus", onFocus);
        };
    }, [active, enabled, pageVisible, refresh]);

    useEffect(
        () =>
            onTasksChanged(() => {
                if (enabled) void refresh();
            }),
        [enabled, refresh],
    );

    return { data, setData, workflow, refresh };
}
