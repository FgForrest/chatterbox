"use client";

import { useEffect, useState } from "react";
import { onTasksChanged } from "@/components/tasks/task-api";

/**
 * How many tasks were assigned to the viewer since they last opened their
 * list, counted again whenever tasks change on the page.
 */
export function usePendingTasks(): number {
    const [pending, setPending] = useState(0);
    useEffect(() => {
        let cancelled = false;
        const count = () =>
            fetch("/api/tasks/pending")
                .then((response) =>
                    response.ok ? response.json() : { count: 0 },
                )
                .then((body: { count?: number }) => {
                    if (!cancelled) setPending(body.count ?? 0);
                })
                .catch(() => {});
        void count();
        const stop = onTasksChanged(() => void count());
        return () => {
            cancelled = true;
            stop();
        };
    }, []);
    return pending;
}
