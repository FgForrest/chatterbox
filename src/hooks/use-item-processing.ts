"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onTasksChanged } from "@/components/tasks/task-api";
import {
    ITEM_PROCESSING_REVALIDATION_MS,
    onItemProcessingInvalidated,
    recentItemProcessingInvalidation,
} from "@/lib/pipeline/item-processing-events";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import { deriveWorkflowStatus } from "@/lib/pipeline/workflow-status";

const ACTIVE_POLL_MS = 5_000;
const INVALIDATED_POLL_MS = 2_000;

interface Revalidation {
    baseline: string;
    until: number;
}

function processingKey(data: ItemProcessingPresentation | null): string {
    return JSON.stringify(data);
}

interface UseItemProcessingOptions {
    itemId: string;
    kind: "audio" | "mail";
    initialData?: ItemProcessingPresentation | null;
    enabled?: boolean;
}

/** Own one item's processing projection and refresh active or invalidated work. */
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
    const dataRef = useRef(data);
    dataRef.current = data;
    const [revalidation, setRevalidation] = useState<Revalidation | null>(
        () => {
            const initialInvalidation =
                recentItemProcessingInvalidation(itemId);
            return initialInvalidation === null
                ? null
                : {
                      baseline: processingKey(initialData ?? null),
                      until:
                          initialInvalidation + ITEM_PROCESSING_REVALIDATION_MS,
                  };
        },
    );
    const revalidationRef = useRef(revalidation);
    revalidationRef.current = revalidation;
    const previousItemId = useRef(itemId);

    useEffect(() => {
        const nextData = initialData?.itemId === itemId ? initialData : null;
        setData(nextData);
        if (previousItemId.current === itemId) return;
        previousItemId.current = itemId;
        dataRef.current = nextData;
        const invalidated = recentItemProcessingInvalidation(itemId);
        const next =
            invalidated === null
                ? null
                : {
                      baseline: processingKey(nextData),
                      until: invalidated + ITEM_PROCESSING_REVALIDATION_MS,
                  };
        revalidationRef.current = next;
        setRevalidation(next);
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
                const next = body.processing ?? null;
                setData(next);
                const current = revalidationRef.current;
                if (current && processingKey(next) !== current.baseline) {
                    revalidationRef.current = null;
                    setRevalidation(null);
                }
            }
        } catch {}
    }, [enabled, itemId, kind]);

    const beginRevalidation = useCallback(
        (at = Date.now()) => {
            if (!enabled) return;
            const next = {
                baseline: processingKey(dataRef.current),
                until: at + ITEM_PROCESSING_REVALIDATION_MS,
            };
            revalidationRef.current = next;
            setRevalidation(next);
            void refresh();
        },
        [enabled, refresh],
    );

    useEffect(() => {
        if (!enabled) return;
        const recent = recentItemProcessingInvalidation(itemId);
        if (recent !== null) {
            beginRevalidation(recent);
            return;
        }
        if (initialData === undefined) void refresh();
    }, [beginRevalidation, enabled, initialData, itemId, refresh]);

    const workflow = useMemo(
        () => (data ? deriveWorkflowStatus(data, kind) : null),
        [data, kind],
    );
    const active =
        workflow?.steps.some(
            (step) => step.state === "queued" || step.state === "working",
        ) ?? false;

    useEffect(() => {
        if (!active || !revalidationRef.current) return;
        revalidationRef.current = null;
        setRevalidation(null);
    }, [active]);

    useEffect(() => {
        const onVisibility = () =>
            setPageVisible(document.visibilityState === "visible");
        document.addEventListener("visibilitychange", onVisibility);
        return () =>
            document.removeEventListener("visibilitychange", onVisibility);
    }, []);

    useEffect(() => {
        if (!enabled || (!active && !revalidation) || !pageVisible) return;
        const poll = () => {
            const current = revalidationRef.current;
            if (!active && current && Date.now() >= current.until) {
                revalidationRef.current = null;
                setRevalidation(null);
                return;
            }
            void refresh();
        };
        const timer = window.setInterval(
            poll,
            active ? ACTIVE_POLL_MS : INVALIDATED_POLL_MS,
        );
        const onFocus = () => void refresh();
        window.addEventListener("focus", onFocus);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener("focus", onFocus);
        };
    }, [active, enabled, pageVisible, refresh, revalidation]);

    useEffect(
        () =>
            onItemProcessingInvalidated(itemId, (at) => {
                beginRevalidation(at);
            }),
        [beginRevalidation, itemId],
    );

    useEffect(
        () =>
            onTasksChanged(() => {
                beginRevalidation();
            }),
        [beginRevalidation],
    );

    return { data, setData, workflow, refresh };
}
