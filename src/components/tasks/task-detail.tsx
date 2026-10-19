"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { announceTasksChanged, changeTask } from "@/components/tasks/task-api";
import { TaskRow } from "@/components/tasks/task-row";
import type { TaskRowChange } from "@/components/tasks/use-recording-tasks";
import type { TaskListItem } from "@/lib/tasks/tasks";

/** One task opened from search, independent of the task list's filters. */
export function TaskDetail({ initialTask }: { initialTask: TaskListItem }) {
    const i18n = useExtracted();
    const { refresh } = useRouter();
    const [task, setTask] = useState(initialTask);
    const version = useRef(initialTask.version);
    const pending = useRef(Promise.resolve());
    useEffect(() => {
        setTask(initialTask);
        version.current = initialTask.version;
    }, [initialTask]);
    const update: TaskRowChange = (change, optimistic) => {
        setTask((current) => ({ ...current, ...optimistic }));
        pending.current = pending.current
            .then(async () => {
                const saved = await changeTask(task.id, {
                    ...change,
                    version: version.current,
                });
                version.current = saved.version;
                setTask((current) => ({ ...current, ...saved }));
                announceTasksChanged();
            })
            .catch(() => {
                toast.error(i18n("Could not save the task"));
                setTask(initialTask);
                refresh();
            });
    };
    return (
        <div className="mx-auto max-w-4xl space-y-4">
            <Link
                href="/tasks"
                className="text-sm text-primary hover:underline"
            >
                {i18n("Tasks")}
            </Link>
            <h1 className="text-xl font-semibold">{task.text}</h1>
            <ul className="rounded-lg border">
                <TaskRow
                    task={task}
                    recording={task.recording}
                    evidence={task.evidence}
                    organizationOnly={task.recording.view === "org"}
                    onChange={update}
                />
            </ul>
        </div>
    );
}
