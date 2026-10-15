"use client";

import { Combine, Loader2, Search } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
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
import type { MergeCandidateView } from "@/lib/tasks/proposals";
import { cn } from "@/lib/utils";

export interface TaskMergeResult {
    ownerNotified?: boolean;
}

/** Search and keyboard-select an eligible open task to merge into. */
export function MergeTaskPicker({
    itemId,
    sourceTaskId,
    label,
    searchLabel,
    onMerge,
}: {
    itemId: string;
    sourceTaskId: string;
    label?: string;
    searchLabel?: string;
    onMerge: (targetTaskId: string) => Promise<TaskMergeResult | boolean>;
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
    const [active, setActive] = useState(0);
    const [selected, setSelected] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [merging, setMerging] = useState(false);

    useEffect(() => {
        if (!open) return;
        const timer = window.setTimeout(
            () => {
                request.current?.abort();
                const controller = new AbortController();
                request.current = controller;
                const params = new URLSearchParams({
                    q: query,
                    offset: "0",
                    limit: "20",
                    sourceTaskId,
                });
                setLoading(true);
                void fetch(
                    `/api/recordings/${encodeURIComponent(itemId)}/tasks/merge?${params.toString()}`,
                    { signal: controller.signal },
                )
                    .then(async (response) => {
                        if (!response.ok) throw new Error();
                        return (await response.json()) as {
                            candidates: MergeCandidateView[];
                        };
                    })
                    .then((body) => {
                        setCandidates(body.candidates);
                        setActive(0);
                        setSelected(null);
                    })
                    .catch((error: unknown) => {
                        if (
                            !(
                                error instanceof DOMException &&
                                error.name === "AbortError"
                            )
                        ) {
                            toast.error(searchErrorRef.current);
                        }
                    })
                    .finally(() => setLoading(false));
            },
            query ? 250 : 0,
        );
        return () => {
            window.clearTimeout(timer);
            request.current?.abort();
        };
    }, [itemId, open, query, sourceTaskId]);

    const merge = async () => {
        if (!selected) return;
        setMerging(true);
        try {
            const result = await onMerge(selected);
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
        } finally {
            setMerging(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button type="button" size="sm" variant="ghost">
                    <Combine className="size-3.5" aria-hidden="true" />
                    {label ?? i18n("Merge into another task")}
                </Button>
            </DialogTrigger>
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
                                    · {candidate.homeItem.title}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
                <DialogFooter>
                    <Button
                        type="button"
                        disabled={!selected || merging}
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
