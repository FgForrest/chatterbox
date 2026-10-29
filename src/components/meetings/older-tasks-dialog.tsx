"use client";

import { Plus, Search } from "lucide-react";
import { useExtracted, useFormatter } from "next-intl";
import { useEffect, useState } from "react";
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
import { groupAgendaTasks } from "@/lib/meetings/task-groups";
import { cn } from "@/lib/utils";
import { meetingRequest, meetingUrl } from "./api";
import type { MeetingDetail, OlderTask } from "./types";
import type { AgendaController } from "./use-agenda";

function searchText(value: string) {
    return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

/** Picks unfinished tasks from the agenda's folders and adds the selected ones to the agenda. */
export function OlderTasksDialog({
    detail,
    open,
    onOpenChange,
    mutate,
}: {
    detail: MeetingDetail;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    mutate: AgendaController["mutate"];
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    const [scope, setScope] = useState<"invited" | "all">("invited");
    const [older, setOlder] = useState<OlderTask[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState(new Map<string, OlderTask>());
    const [adding, setAdding] = useState(false);
    const loadError = i18n("Could not load tasks");
    useEffect(() => {
        if (!open) {
            setSelected(new Map());
            setQuery("");
            return;
        }
        const controller = new AbortController();
        setOlder(null);
        setError(null);
        void meetingRequest<{ tasks: OlderTask[] }>(
            meetingUrl(detail.id, `/older-tasks?scope=${scope}`),
            "GET",
            undefined,
            controller.signal,
        )
            .then((result) => {
                if (!controller.signal.aborted) setOlder(result.tasks);
            })
            .catch(() => {
                if (!controller.signal.aborted) setError(loadError);
            });
        return () => controller.abort();
    }, [detail.id, open, scope, loadError]);

    const inAgenda = new Set(
        detail.tasks.filter((task) => !task.removedAt).map((task) => task.id),
    );
    const available = older?.filter((task) => !inAgenda.has(task.id)) ?? [];
    const matching = available.filter((task) =>
        searchText(task.text).includes(searchText(query.trim())),
    );
    const groups = groupAgendaTasks(matching, detail.invitees).filter(
        (group) => group.tasks.length,
    );
    const selection = [...selected.values()].filter(
        (task) => !inAgenda.has(task.id),
    );
    const add = async () => {
        if (adding || !selection.length) return;
        setAdding(true);
        let failed = false;
        for (const task of selection) {
            try {
                const saved = await mutate(
                    "/tasks",
                    "POST",
                    { taskId: task.id },
                    (value) => ({
                        ...value,
                        tasks: [
                            ...value.tasks.filter(
                                (entry) => entry.id !== task.id,
                            ),
                            {
                                ...task,
                                removedAt: null,
                                agendaNote: null,
                                agendaOrigin: "older",
                                position: 100000,
                            },
                        ],
                    }),
                );
                if (saved) {
                    setSelected((current) => {
                        const next = new Map(current);
                        next.delete(task.id);
                        return next;
                    });
                } else failed = true;
            } catch {
                failed = true;
                toast.error(i18n("Could not save the agenda"));
            }
        }
        setAdding(false);
        if (!failed) {
            setSelected(new Map());
            onOpenChange(false);
        }
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next && adding) return;
                onOpenChange(next);
            }}
        >
            <DialogTrigger asChild>
                <Button variant="ghost" size="sm">
                    <Plus className="mr-1 size-3.5" aria-hidden="true" />
                    {i18n("Add older tasks…")}
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>{i18n("Add older tasks")}</DialogTitle>
                    <DialogDescription>
                        {i18n(
                            "Unfinished tasks from this agenda's folders that are not in it yet.",
                        )}
                    </DialogDescription>
                </DialogHeader>
                <label className="relative block">
                    <span className="sr-only">{i18n("Search tasks")}</span>
                    <Search
                        className="absolute top-2.5 left-2.5 size-4 text-muted-foreground"
                        aria-hidden="true"
                    />
                    <input
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={i18n("Search tasks")}
                        className="h-9 w-full rounded-md border bg-background pr-3 pl-9 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                    />
                </label>
                <div className="flex w-fit gap-1 rounded-md border bg-muted p-1">
                    {(["invited", "all"] as const).map((value) => (
                        <Button
                            key={value}
                            size="sm"
                            variant={scope === value ? "secondary" : "ghost"}
                            aria-pressed={scope === value}
                            disabled={adding}
                            onClick={() => {
                                setScope(value);
                                if (value !== scope) setSelected(new Map());
                            }}
                        >
                            {value === "invited"
                                ? i18n("Invitees only")
                                : i18n("Everyone")}
                        </Button>
                    ))}
                </div>
                <div className="max-h-[50vh] space-y-3 overflow-y-auto">
                    {error ? (
                        <p role="alert">{error}</p>
                    ) : older === null ? (
                        <output>{i18n("Loading tasks…")}</output>
                    ) : !available.length ? (
                        <p className="text-sm text-muted-foreground">
                            {i18n("No older unfinished tasks")}
                        </p>
                    ) : !matching.length ? (
                        <p className="text-sm text-muted-foreground">
                            {i18n("Nothing matches the search.")}
                        </p>
                    ) : (
                        groups.map((group) => (
                            <section
                                key={group.name ?? "unassigned"}
                                className="space-y-2"
                            >
                                <h3 className="text-sm font-medium">
                                    {group.name ?? i18n("No assignee")}
                                    {!group.invited && group.name && (
                                        <span className="ml-2 rounded border px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                                            {i18n("Not invited")}
                                        </span>
                                    )}
                                </h3>
                                <ul className="divide-y rounded-lg border">
                                    {group.tasks.map((task) => {
                                        const source =
                                            task.evidence ?? task.recording;
                                        return (
                                            <li key={task.id}>
                                                <label
                                                    className={cn(
                                                        "flex cursor-pointer items-start gap-3 p-3 text-sm focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring",
                                                        selected.has(task.id) &&
                                                            "bg-primary/10",
                                                    )}
                                                >
                                                    <input
                                                        type="checkbox"
                                                        className="mt-1 size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-ring"
                                                        aria-label={task.text}
                                                        checked={selected.has(
                                                            task.id,
                                                        )}
                                                        disabled={adding}
                                                        onChange={(event) => {
                                                            const checked =
                                                                event.target
                                                                    .checked;
                                                            setSelected(
                                                                (current) => {
                                                                    const next =
                                                                        new Map(
                                                                            current,
                                                                        );
                                                                    if (checked)
                                                                        next.set(
                                                                            task.id,
                                                                            task,
                                                                        );
                                                                    else
                                                                        next.delete(
                                                                            task.id,
                                                                        );
                                                                    return next;
                                                                },
                                                            );
                                                        }}
                                                    />
                                                    <span className="min-w-0">
                                                        <span className="block whitespace-pre-wrap">
                                                            {task.text}
                                                        </span>
                                                        <span className="block text-xs text-muted-foreground">
                                                            {source?.title ??
                                                                i18n(
                                                                    "Own task",
                                                                )}{" "}
                                                            ·{" "}
                                                            {format.dateTime(
                                                                new Date(
                                                                    source?.startTime ??
                                                                        task.createdAt,
                                                                ),
                                                                {
                                                                    dateStyle:
                                                                        "medium",
                                                                },
                                                            )}{" "}
                                                            ·{" "}
                                                            {task.dueDate
                                                                ? format.dateTime(
                                                                      new Date(
                                                                          `${task.dueDate}T12:00:00`,
                                                                      ),
                                                                      {
                                                                          dateStyle:
                                                                              "medium",
                                                                      },
                                                                  )
                                                                : i18n(
                                                                      "No due date",
                                                                  )}
                                                        </span>
                                                    </span>
                                                </label>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </section>
                        ))
                    )}
                </div>
                <DialogFooter className="sm:items-center sm:justify-between">
                    <p
                        className="text-sm text-muted-foreground"
                        aria-live="polite"
                    >
                        {selection.length
                            ? i18n("Selected: {count, number}", {
                                  count: selection.length,
                              })
                            : i18n("Nothing selected")}
                    </p>
                    <div className="flex justify-end gap-2">
                        <Button
                            variant="outline"
                            disabled={adding}
                            onClick={() => onOpenChange(false)}
                        >
                            {i18n("Cancel")}
                        </Button>
                        <Button
                            disabled={
                                !selection.length ||
                                adding ||
                                older === null ||
                                Boolean(error)
                            }
                            onClick={() => void add()}
                        >
                            {selection.length
                                ? i18n(
                                      "Add {count, plural, one {# task} other {# tasks}}",
                                      { count: selection.length },
                                  )
                                : i18n("Add tasks")}
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
