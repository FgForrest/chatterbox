"use client";

import { Ban, Inbox, Loader2, UserRoundPen } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { announceTasksChanged } from "@/components/tasks/task-api";
import { TaskEvidenceLink } from "@/components/tasks/task-evidence-link";
import { Button } from "@/components/ui/button";
import type {
    ObsoleteProposalReason,
    RoutedProposalDecision,
    RoutedTaskProposalView,
} from "@/lib/tasks/routing";

/** Task changes routed to this person for a fresh apply/reject decision. */
export function RoutedProposalsInbox() {
    const i18n = useExtracted();
    const loadError = i18n("Could not load task proposals");
    const loadErrorRef = useRef(loadError);
    loadErrorRef.current = loadError;
    const [rows, setRows] = useState<RoutedTaskProposalView[]>([]);
    const [results, setResults] = useState(
        new Map<string, RoutedProposalDecision>(),
    );
    const [busy, setBusy] = useState<string | null>(null);
    const obsoleteMessage = (reason: ObsoleteProposalReason | null) => {
        switch (reason) {
            case "earlier_statement":
                return i18n(
                    "Obsolete: newer information already set this field.",
                );
            case "version_changed":
                return i18n(
                    "Obsolete: the task changed after this proposal was made.",
                );
            case "task_closed":
                return i18n("Obsolete: the task is no longer open.");
            case "task_invisible":
                return i18n("Obsolete: you can no longer see the task.");
            case "rights_lost":
                return i18n("Obsolete: you can no longer make this change.");
            case "source_withdrawn":
                return i18n("Obsolete: the source item is no longer shared.");
            default:
                return i18n(
                    "Obsolete: this proposal can no longer be applied.",
                );
        }
    };

    useEffect(() => {
        void fetch("/api/tasks/pending?include=proposals")
            .then(async (response) => {
                if (!response.ok) throw new Error();
                return (await response.json()) as {
                    proposals: RoutedTaskProposalView[];
                };
            })
            .then((body) => setRows(body.proposals))
            .catch(() => toast.error(loadErrorRef.current));
    }, []);

    const decide = async (
        row: RoutedTaskProposalView,
        decision: "apply" | "reject",
    ) => {
        setBusy(row.id);
        try {
            const response = await fetch(
                `/api/recordings/${encodeURIComponent(row.sourceItemId)}/tasks/updates/${encodeURIComponent(row.id)}`,
                {
                    method: "PATCH",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ decision }),
                },
            );
            if (!response.ok) throw new Error();
            const result = (await response.json()) as RoutedProposalDecision;
            setResults((current) => new Map(current).set(row.id, result));
            announceTasksChanged();
        } catch {
            toast.error(i18n("Could not save the decision"));
        } finally {
            setBusy(null);
        }
    };

    if (rows.length === 0) return null;
    return (
        <section
            className="rounded-lg border bg-card p-4"
            aria-labelledby="routed-task-proposals"
        >
            <h2
                id="routed-task-proposals"
                className="flex items-center gap-2 font-semibold"
            >
                <Inbox className="size-4" aria-hidden="true" />
                {i18n("Proposals for you")}
            </h2>
            <ul className="mt-2 divide-y">
                {rows.map((row) => {
                    const result = results.get(row.id);
                    const notice = row.kind === "attach_merge";
                    return (
                        <li key={row.id} className="space-y-2 py-3 text-sm">
                            <p className="flex items-start gap-1.5">
                                {notice && row.sourceItem ? (
                                    i18n(
                                        "{person} attached their task {task} from {item}",
                                        {
                                            person:
                                                row.proposedBy?.name ??
                                                i18n("Someone"),
                                            task: row.taskText,
                                            item: row.sourceItem.title,
                                        },
                                    )
                                ) : notice ? (
                                    i18n(
                                        "{person} attached their task {task}",
                                        {
                                            person:
                                                row.proposedBy?.name ??
                                                i18n("Someone"),
                                            task: row.taskText,
                                        },
                                    )
                                ) : row.kind === "done" ? (
                                    <span>
                                        <span className="font-medium">
                                            {i18n("Mark done")}
                                        </span>
                                        : {row.taskText}
                                        <span className="block text-xs text-muted-foreground">
                                            {i18n("Open")} → {i18n("Done")}
                                        </span>
                                    </span>
                                ) : row.kind === "drop" ? (
                                    <>
                                        <Ban className="mt-0.5 size-3.5 shrink-0" />
                                        <span>
                                            <span className="font-medium">
                                                {i18n("No longer needed")}
                                            </span>
                                            : {row.taskText}
                                            <span className="block text-xs text-muted-foreground">
                                                {i18n("Open")} →{" "}
                                                {i18n("No longer needed")}
                                            </span>
                                        </span>
                                    </>
                                ) : row.kind === "assignee" ? (
                                    <>
                                        <UserRoundPen className="mt-0.5 size-3.5 shrink-0" />
                                        <span>
                                            <span className="font-medium">
                                                {i18n("Handed to someone else")}
                                            </span>
                                            : {row.taskText}
                                            <span
                                                className="block text-xs text-muted-foreground"
                                                title={
                                                    row.proposedAssigneeHint
                                                        ? i18n(
                                                              "Heard {name}, who is not in Almanac.",
                                                              {
                                                                  name: row.proposedAssigneeHint,
                                                              },
                                                          )
                                                        : row.proposedAssigneeCheck
                                                          ? i18n(
                                                                "Check this assignment",
                                                            )
                                                          : undefined
                                                }
                                            >
                                                {row.currentAssigneeName ??
                                                    i18n("Unassigned")}{" "}
                                                →{" "}
                                                {row.proposedAssignee?.name ??
                                                    (row.proposedAssigneeHint
                                                        ? `${row.proposedAssigneeHint}?`
                                                        : i18n("Unassigned"))}
                                            </span>
                                        </span>
                                    </>
                                ) : (
                                    <span>
                                        <span className="font-medium">
                                            {i18n("Change the deadline")}
                                        </span>
                                        : {row.taskText}
                                        <span className="block text-xs text-muted-foreground">
                                            {row.currentDueDate ??
                                                row.currentDuePhrase ??
                                                i18n("No due date")}{" "}
                                            →{" "}
                                            {row.dueDate ??
                                                row.duePhrase ??
                                                i18n("No due date")}
                                        </span>
                                    </span>
                                )}
                            </p>
                            {!notice && (
                                <p className="text-xs text-muted-foreground">
                                    {i18n("Proposed by {person}", {
                                        person:
                                            row.proposedBy?.name ??
                                            i18n("Someone"),
                                    })}
                                </p>
                            )}
                            {row.sourceItem && (
                                <TaskEvidenceLink
                                    evidence={{
                                        itemId: row.sourceItem.id,
                                        itemKind: row.sourceItem.kind,
                                        audioAvailable:
                                            row.sourceItem.audioAvailable,
                                        startMs: row.evidenceStartMs,
                                        text: row.evidenceText,
                                    }}
                                    quote={row.quote}
                                />
                            )}
                            {result ? (
                                <output className="text-xs font-medium">
                                    {result.state === "obsolete"
                                        ? obsoleteMessage(result.obsoleteReason)
                                        : result.state === "applied"
                                          ? i18n("Applied")
                                          : notice
                                            ? i18n("Dismissed")
                                            : i18n("Rejected")}
                                </output>
                            ) : (
                                <div className="flex gap-2">
                                    {!notice && (
                                        <Button
                                            size="sm"
                                            disabled={busy === row.id}
                                            onClick={() =>
                                                void decide(row, "apply")
                                            }
                                        >
                                            {i18n("Apply")}
                                        </Button>
                                    )}
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={busy === row.id}
                                        onClick={() =>
                                            void decide(row, "reject")
                                        }
                                    >
                                        {busy === row.id && (
                                            <Loader2
                                                className="size-3.5 animate-spin"
                                                aria-hidden="true"
                                            />
                                        )}
                                        {notice
                                            ? i18n("Dismiss")
                                            : i18n("Reject")}
                                    </Button>
                                </div>
                            )}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
