"use client";

import { Plus } from "lucide-react";
import { useExtracted } from "next-intl";
import type { RefObject } from "react";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type { TaskAssignee } from "@/lib/tasks/tasks";

const ALL = "all";

/** State filter shared by the task page and folder panel. */
export function TaskStateSelect({
    state,
    onChange,
}: {
    state: string;
    onChange: (value: string) => void;
}) {
    const i18n = useExtracted();
    return (
        <Select value={state} onValueChange={(value) => onChange(value)}>
            <SelectTrigger
                className="h-8 w-32 text-xs"
                aria-label={i18n("State")}
            >
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="open">{i18n("Open tasks")}</SelectItem>
                <SelectItem value="done">{i18n("Done")}</SelectItem>
                <SelectItem value="dropped">{i18n("Dropped")}</SelectItem>
                <SelectItem value="all">{i18n("All states")}</SelectItem>
            </SelectContent>
        </Select>
    );
}

/** Assignee filter shared by Followed and All. */
export function TaskAssigneeSelect({
    assignee,
    assignees,
    onChange,
}: {
    assignee: string;
    assignees: TaskAssignee[];
    onChange: (value: string) => void;
}) {
    const i18n = useExtracted();
    return (
        <Select value={assignee} onValueChange={(value) => onChange(value)}>
            <SelectTrigger
                className="h-8 w-48 text-xs"
                aria-label={i18n("Assignee")}
            >
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value={ALL}>{i18n("All assignees")}</SelectItem>
                <SelectItem value="none">{i18n("No assignee")}</SelectItem>
                {assignees.map((person) => (
                    <SelectItem key={person.personId} value={person.personId}>
                        {person.name}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

/** An inactive trigger while its inline own-task editor is open. */
export function AddTaskTrigger({
    open,
    saving,
    triggerRef,
    onOpen,
}: {
    open: boolean;
    saving: boolean;
    triggerRef: RefObject<HTMLButtonElement | null>;
    onOpen: () => void;
}) {
    const i18n = useExtracted();
    return (
        <button
            ref={triggerRef}
            type="button"
            aria-disabled={open || saving}
            aria-expanded={open}
            onClick={() => {
                if (!open && !saving) onOpen();
            }}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors hover:bg-accent aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent"
        >
            <Plus className="size-3.5" aria-hidden="true" />
            {i18n("Add task")}
        </button>
    );
}
