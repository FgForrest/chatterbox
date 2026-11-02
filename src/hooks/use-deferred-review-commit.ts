"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/** Hide a review until its Undo toast closes, flushing pending work when leaving the page. */
export function useDeferredReviewCommit() {
    const [hidden, setHidden] = useState(false);
    const pending = useRef<null | {
        commit: (keepalive: boolean) => Promise<void>;
        toastId: string | number;
    }>(null);
    const mounted = useRef(true);
    const flush = (keepalive: boolean) => {
        const work = pending.current;
        if (!work) return;
        pending.current = null;
        toast.dismiss(work.toastId);
        void work
            .commit(keepalive)
            .catch(() => undefined)
            .finally(() => {
                if (mounted.current) setHidden(false);
            });
    };
    const flushRef = useRef(flush);
    flushRef.current = flush;
    useEffect(() => {
        mounted.current = true;
        const hide = () => {
            if (document.visibilityState === "hidden") flushRef.current(true);
        };
        const leave = () => flushRef.current(true);
        document.addEventListener("visibilitychange", hide);
        window.addEventListener("pagehide", leave);
        return () => {
            mounted.current = false;
            document.removeEventListener("visibilitychange", hide);
            window.removeEventListener("pagehide", leave);
            flushRef.current(true);
        };
    }, []);
    return {
        hidden,
        defer(
            message: string,
            undoLabel: string,
            commit: (keepalive: boolean) => Promise<void>,
        ) {
            if (pending.current) return;
            setHidden(true);
            const toastId = toast.success(message, {
                duration: 8000,
                action: {
                    label: undoLabel,
                    onClick: () => {
                        pending.current = null;
                        setHidden(false);
                    },
                },
                onDismiss: () => flushRef.current(false),
                onAutoClose: () => flushRef.current(false),
            });
            pending.current = { commit, toastId };
        },
    };
}
