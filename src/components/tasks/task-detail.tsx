"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
    announceTasksChanged,
    changeTask,
    mergeTaskIntoTarget,
} from "@/components/tasks/task-api";
import { TaskRow } from "@/components/tasks/task-row";
import type { TaskRowChange } from "@/components/tasks/use-recording-tasks";
import { useTaskFolderTree } from "@/hooks/use-task-folder-tree";
import type { TaskListItem } from "@/lib/tasks/tasks";

/** One task opened from search, independent of the task list's filters. */
export function TaskDetail({ initialTask }: { initialTask: TaskListItem }) {
    const i18n = useExtracted();
    const { refresh, replace } = useRouter();
    const [task, setTask] = useState(initialTask);
    const folders = useTaskFolderTree(initialTask.own);
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
                    folders={folders}
                    recording={task.recording}
                    evidence={task.evidence}
                    organizationOnly={task.recording?.view === "org"}
                    onChange={update}
                    onMerge={async (target, options) => {
                        const saved = await mergeTaskIntoTarget(
                            task.id,
                            target,
                            options,
                        );
                        announceTasksChanged();
                        if (saved.id === task.id) refresh();
                        else replace(`/tasks/${encodeURIComponent(saved.id)}`);
                        return { ownerNotified: saved.mergeOwnerNotified };
                    }}
                />
            </ul>
        </div>
    );
}
