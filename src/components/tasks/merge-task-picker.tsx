"use client";

import { Combine, Loader2, Search } from "lucide-react";
import { useExtracted } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import {
    previewTaskMerge,
    type TaskMergeOptions,
} from "@/components/tasks/task-api";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { ActionTooltip } from "@/components/ui/tooltip";
import type { MergeCandidateView } from "@/lib/tasks/proposals";
import type { TaskMergePreview } from "@/lib/tasks/tasks";
import { cn } from "@/lib/utils";

export interface TaskMergeResult {
    ownerNotified?: boolean;
}

/** Search and keyboard-select an eligible open task to merge into. */
export function MergeTaskPicker({
    itemId,
    sourceTaskId,
    taskVersion,
    label,
    searchLabel,
    inlineTrigger = false,
    onMerge,
}: {
    itemId: string | null;
    sourceTaskId: string;
    taskVersion?: number;
    label?: string;
    searchLabel?: string;
    inlineTrigger?: boolean;
    onMerge: (
        targetTaskId: string,
        options?: TaskMergeOptions,
    ) => Promise<TaskMergeResult | boolean>;
}) {
    const i18n = useExtracted();
    const searchError = i18n("Could not search tasks");
    const searchErrorRef = useRef(searchError);
    searchErrorRef.current = searchError;
    const listId = useId();
    const request = useRef<AbortController | null>(null);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [candidates, setCandidates] = useState<MergeCandidateView[]>([]);
    const [nextOffset, setNextOffset] = useState<number | null>(null);
    const [active, setActive] = useState(0);
    const [selected, setSelected] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [merging, setMerging] = useState(false);
    const [preview, setPreview] = useState<TaskMergePreview | null>(null);
    const [confirmed, setConfirmed] = useState(false);
    useEffect(() => {
        setPreview(null);
        setConfirmed(false);
        if (!open || !selected || taskVersion === undefined) return;
        let current = true;
        void previewTaskMerge(sourceTaskId, selected)
            .then((value) => {
                if (current) setPreview(value);
            })
            .catch(() => {
                if (current) toast.error(searchErrorRef.current);
            });
        return () => {
            current = false;
        };
    }, [open, selected, sourceTaskId, taskVersion]);

    const loadPage = useCallback(
        async (offset: number, replace: boolean) => {
            request.current?.abort();
            const controller = new AbortController();
            request.current = controller;
            const params = new URLSearchParams({
                q: query,
                offset: String(offset),
                limit: "20",
                sourceTaskId,
            });
            setLoading(true);
            try {
                const response = await fetch(
                    taskVersion !== undefined
                        ? `/api/tasks/${encodeURIComponent(sourceTaskId)}/merge?${params.toString()}`
                        : `/api/recordings/${encodeURIComponent(itemId ?? "")}/tasks/merge?${params.toString()}`,
                    { signal: controller.signal },
                );
                if (!response.ok) throw new Error();
                const body = (await response.json()) as {
                    candidates: MergeCandidateView[];
                    nextOffset: number | null;
                };
                setCandidates((current) => {
                    if (replace) return body.candidates;
                    const known = new Set(
                        current.map((candidate) => candidate.id),
                    );
                    return [
                        ...current,
                        ...body.candidates.filter(
                            (candidate) => !known.has(candidate.id),
                        ),
                    ];
                });
                setNextOffset(body.nextOffset ?? null);
                if (replace) {
                    setActive(0);
                    setSelected(null);
                }
            } catch (error) {
                if (
                    !(
                        error instanceof DOMException &&
                        error.name === "AbortError"
                    )
                ) {
                    toast.error(searchErrorRef.current);
                }
            } finally {
                if (request.current === controller) setLoading(false);
            }
        },
        [itemId, query, sourceTaskId, taskVersion],
    );

    useEffect(() => {
        if (!open) return;
        const timer = window.setTimeout(
            () => {
                void loadPage(0, true);
            },
            query ? 250 : 0,
        );
        return () => {
            window.clearTimeout(timer);
            request.current?.abort();
        };
    }, [loadPage, open, query]);

    const merge = async () => {
        if (!selected) return;
        setMerging(true);
        try {
            const result = await onMerge(
                selected,
                preview
                    ? {
                          sourceVersion:
                              preview.keepId === sourceTaskId
                                  ? preview.keepVersion
                                  : preview.mergeVersion,
                          targetVersion:
                              preview.keepId === sourceTaskId
                                  ? preview.mergeVersion
                                  : preview.keepVersion,
                          confirmPrivateToShared: confirmed,
                      }
                    : undefined,
            );
            if (result === false) return;
            setOpen(false);
            if (typeof result === "object" && result.ownerNotified) {
                toast.success(
                    i18n(
                        "Merged. The target's owner was notified, and differences were sent to them.",
                    ),
                );
            } else {
                toast.success(i18n("Tasks merged"));
            }
        } catch {
            toast.error(i18n("Could not save the task"));
        } finally {
            setMerging(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            {inlineTrigger ? (
                <ActionTooltip label={label ?? i18n("Merge into another task")}>
                    <DialogTrigger asChild>
                        <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            aria-label={
                                label ?? i18n("Merge into another task")
                            }
                            className="text-muted-foreground hover:text-foreground"
                        >
                            <Combine className="size-3" aria-hidden="true" />
                        </Button>
                    </DialogTrigger>
                </ActionTooltip>
            ) : (
                <DialogTrigger asChild>
                    <Button type="button" size="sm" variant="ghost">
                        <Combine className="size-3.5" aria-hidden="true" />
                        {label ?? i18n("Merge into another task")}
                    </Button>
                </DialogTrigger>
            )}
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>{i18n("Merge into another task")}</DialogTitle>
                    <DialogDescription>
                        {i18n("Choose the open task that should remain.")}
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-2">
                    <label className="relative block">
                        <span className="sr-only">
                            {searchLabel ?? i18n("Search tasks")}
                        </span>
                        <Search
                            className="absolute top-2.5 left-2.5 size-4 text-muted-foreground"
                            aria-hidden="true"
                        />
                        <input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "ArrowDown") {
                                    event.preventDefault();
                                    setActive((value) =>
                                        Math.min(
                                            value + 1,
                                            candidates.length - 1,
                                        ),
                                    );
                                } else if (event.key === "ArrowUp") {
                                    event.preventDefault();
                                    setActive((value) =>
                                        Math.max(value - 1, 0),
                                    );
                                } else if (
                                    event.key === "Enter" &&
                                    candidates[active]
                                ) {
                                    event.preventDefault();
                                    setSelected(candidates[active].id);
                                }
                            }}
                            role="combobox"
                            aria-expanded="true"
                            aria-controls={listId}
                            aria-activedescendant={
                                candidates[active]
                                    ? `${listId}-${candidates[active].id}`
                                    : undefined
                            }
                            placeholder={searchLabel ?? i18n("Search tasks")}
                            className="h-9 w-full rounded-md border bg-background pr-3 pl-9 text-sm"
                        />
                    </label>
                    <div
                        id={listId}
                        role="listbox"
                        aria-label={i18n("Merge targets")}
                        className="max-h-72 space-y-1 overflow-y-auto"
                    >
                        {loading && (
                            <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                                <Loader2
                                    className="size-4 animate-spin"
                                    aria-hidden="true"
                                />
                                {i18n("Searching tasks…")}
                            </p>
                        )}
                        {!loading && candidates.length === 0 && (
                            <p className="p-3 text-sm text-muted-foreground">
                                {i18n("No matching open tasks")}
                            </p>
                        )}
                        {candidates.map((candidate, index) => (
                            <button
                                key={candidate.id}
                                id={`${listId}-${candidate.id}`}
                                type="button"
                                role="option"
                                aria-selected={selected === candidate.id}
                                onMouseMove={() => setActive(index)}
                                onClick={() => setSelected(candidate.id)}
                                className={cn(
                                    "block w-full rounded-md border p-2 text-left text-sm",
                                    active === index && "border-primary",
                                    selected === candidate.id &&
                                        "bg-primary/10 ring-1 ring-primary",
                                )}
                            >
                                <span className="block font-medium">
                                    {candidate.text}
                                </span>
                                <span className="block text-xs text-muted-foreground">
                                    {candidate.assignee?.name ??
                                        i18n("Unassigned")}{" "}
                                    ·{" "}
                                    {candidate.dueDate ??
                                        candidate.duePhrase ??
                                        i18n("No due date")}{" "}
                                    ·{" "}
                                    {candidate.homeItem?.title ??
                                        i18n("Own task")}
                                </span>
                            </button>
                        ))}
                    </div>
                    {nextOffset !== null && (
                        <Button
                            type="button"
                            variant="ghost"
                            className="w-full"
                            disabled={loading}
                            onClick={() => void loadPage(nextOffset, false)}
                        >
                            {loading
                                ? i18n("Searching tasks…")
                                : i18n("Show more tasks")}
                        </Button>
                    )}
                </div>
                {preview && (
                    <div className="space-y-2 rounded-md border border-dashed p-3 text-sm">
                        <p className="font-medium">{i18n("Result")}</p>
                        <p className="whitespace-pre-wrap">{preview.text}</p>
                        {preview.note && (
                            <p className="whitespace-pre-wrap border-l-2 pl-2">
                                {preview.note}
                            </p>
                        )}
                        <p>
                            {i18n("Due date")}:{" "}
                            {preview.dueDate ?? i18n("No due date")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {i18n(
                                "Links and followers of both tasks stay. This cannot be undone.",
                            )}
                        </p>
                        {preview.privateToShared && (
                            <label className="flex gap-2 rounded-md bg-amber-500/10 p-2">
                                <input
                                    type="checkbox"
                                    checked={confirmed}
                                    onChange={(event) =>
                                        setConfirmed(event.target.checked)
                                    }
                                />
                                <span>
                                    {i18n(
                                        "The Organization task will remain. Your private text and note will be visible to everyone who can see it. Confirm to merge.",
                                    )}
                                </span>
                            </label>
                        )}
                    </div>
                )}
                <DialogFooter>
                    <Button
                        type="button"
                        disabled={
                            !selected ||
                            merging ||
                            (taskVersion !== undefined &&
                                (!preview ||
                                    (preview.privateToShared && !confirmed)))
                        }
                        onClick={() => void merge()}
                    >
                        {merging && (
                            <Loader2
                                className="size-4 animate-spin"
                                aria-hidden="true"
                            />
                        )}
                        {i18n("Merge task")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
