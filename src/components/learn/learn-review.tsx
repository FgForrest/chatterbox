"use client";

import { GraduationCap, Loader2 } from "lucide-react";
import { useExtracted } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getApiErrorMessage } from "@/lib/api-errors";
import { followJob } from "@/lib/jobs/client";
import type { RecordingView } from "@/lib/sharing/view";
import { withRecordingView } from "@/lib/sharing/view";
import { formatClock } from "@/lib/topics/timeline";
import type { TranscriptTurn } from "@/lib/transcription/turns";

type Target = { personId: string } | { entityId: string };
type Side = Target | { speakerLabel: string } | { literal: string };

interface ItemView {
    id: string;
    kind: "speaker" | "correction" | "known_fact" | "fact" | "relation_phrase";
    preTicked: boolean;
    decision: "accepted" | "rejected" | null;
    choice: Record<string, unknown> | null;
    version: number;
    dependsOnLabel: string | null;
    // The shape follows the kind; read field by field below.
    payload: Record<string, unknown>;
}

interface ReviewState {
    run: { id: string; status: string } | null;
    items: ItemView[];
    names: Record<string, string>;
    types: Record<string, string>;
    relations: Record<string, string>;
    available: boolean;
}

const POLL_MS = 3_000;

/**
 * Learn on a transcript, and the review of what it proposed: the button
 * that starts a run, and once it is ready the review with its two
 * defaults (pre-ticked: corrections a person confirmed before, known facts
 * mentioned again; everything else unticked). Drafts are kept on the server
 * as they are ticked; "Finish review" applies what is ticked and remembers
 * the rest. Only whoever may change the recording in the view sees it.
 */
export function LearnReview({
    recordingId,
    view,
    source,
    turns,
    onSeek,
    onFinished,
}: {
    recordingId: string;
    view?: RecordingView;
    source: "plaud" | "riffado";
    turns: readonly TranscriptTurn[];
    onSeek?: (ms: number) => void;
    /** The transcript's speakers and corrections changed: reload them. */
    onFinished?: () => void;
}) {
    const i18n = useExtracted();
    const [state, setState] = useState<ReviewState | null>(null);
    const [open, setOpen] = useState(false);
    const [running, setRunning] = useState(false);
    const [finishing, setFinishing] = useState(false);

    const url = useCallback(
        (path: string) =>
            withRecordingView(`/api/recordings/${recordingId}/${path}`, view),
        [recordingId, view],
    );

    const load = useCallback(async () => {
        const response = await fetch(url("review"));
        if (!response.ok) return;
        setState((await response.json()) as ReviewState);
    }, [url]);

    useEffect(() => {
        void load();
    }, [load]);

    const learn = async () => {
        setRunning(true);
        try {
            const response = await fetch(
                withRecordingView(
                    `/api/recordings/${recordingId}/learn?source=${source}`,
                    view,
                ),
                { method: "POST" },
            );
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(response, i18n("Learn failed")),
                );
                return;
            }
            const { jobId } = (await response.json()) as {
                jobId: string | null;
            };
            if (jobId) {
                const job = await followJob(jobId, { pollMs: POLL_MS });
                if (job?.status === "failed") {
                    toast.error(job.error || i18n("Learn failed"));
                }
            }
            await load();
        } finally {
            setRunning(false);
        }
    };

    const ticked = (item: ItemView) =>
        (item.decision ?? (item.preTicked ? "accepted" : "rejected")) ===
        "accepted";

    const decide = async (
        item: ItemView,
        decision: "accepted" | "rejected",
        choice: Record<string, unknown> | null = item.choice,
    ) => {
        const response = await fetch(url(`review/items/${item.id}`), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision, version: item.version, choice }),
        });
        if (!response.ok) {
            toast.error(
                await getApiErrorMessage(
                    response,
                    i18n("Could not keep that decision"),
                ),
            );
            await load();
            return;
        }
        const { version } = (await response.json()) as { version: number };
        setState((current) =>
            current
                ? {
                      ...current,
                      items: current.items.map((other) =>
                          other.id === item.id
                              ? { ...other, decision, choice, version }
                              : other,
                      ),
                  }
                : current,
        );
    };

    const finish = async () => {
        if (!state) return;
        setFinishing(true);
        try {
            const response = await fetch(url("review/finish"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    versions: Object.fromEntries(
                        state.items.map((item) => [item.id, item.version]),
                    ),
                }),
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not finish the review"),
                    ),
                );
                await load();
                return;
            }
            const result = (await response.json()) as {
                status: string;
                applied: number;
                skipped: { reason: string }[];
            };
            if (result.status === "superseded") {
                toast.error(
                    i18n(
                        "The transcript changed since Learn read it. Run Learn again.",
                    ),
                );
            } else {
                toast.success(
                    i18n(
                        "Review finished: {count, plural, one {# change} other {# changes}} made",
                        { count: result.applied },
                    ),
                );
                for (const skipped of result.skipped) {
                    toast.warning(skipped.reason);
                }
            }
            setOpen(false);
            await load();
            onFinished?.();
        } finally {
            setFinishing(false);
        }
    };

    const nameOf = useCallback(
        (side: Side | undefined): string => {
            if (!side) return "?";
            if ("literal" in side) return `"${side.literal}"`;
            if ("speakerLabel" in side) return side.speakerLabel;
            const id = "personId" in side ? side.personId : side.entityId;
            return state?.names[id] ?? "?";
        },
        [state],
    );
    const turnStart = (turnIndex: number) => turns[turnIndex]?.startMs ?? 0;

    const groups = useMemo(() => {
        const items = state?.items ?? [];
        return {
            speakers: items.filter((item) => item.kind === "speaker"),
            corrections: items.filter((item) => item.kind === "correction"),
            known: items.filter((item) => item.kind === "known_fact"),
            facts: items.filter((item) => item.kind === "fact"),
            phrases: items.filter((item) => item.kind === "relation_phrase"),
        };
    }, [state]);

    const ready = state?.run?.status === "ready";
    if (!state?.available && !ready) return null;
    const pending =
        state?.run?.status === "queued" || state?.run?.status === "running";
    const count = state?.items.length ?? 0;

    const seek = (ms: number, label?: string) => (
        <button
            type="button"
            className="font-mono text-xs text-primary hover:underline"
            onClick={() => onSeek?.(ms)}
            aria-label={i18n("Play from {time}", { time: formatClock(ms) })}
        >
            {label ?? `▸${formatClock(ms)}`}
        </button>
    );

    const checkbox = (item: ItemView, label: string) => (
        <input
            type="checkbox"
            className="mt-1 size-4 shrink-0"
            checked={ticked(item)}
            aria-label={label}
            onChange={(event) =>
                void decide(
                    item,
                    event.target.checked ? "accepted" : "rejected",
                )
            }
        />
    );

    return (
        <>
            {ready ? (
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto gap-1 px-0 text-sm font-medium hover:bg-transparent hover:text-primary"
                    onClick={() => setOpen(true)}
                >
                    <GraduationCap className="size-4" />
                    {i18n("Review ({count})", { count: String(count) })}
                </Button>
            ) : (
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto gap-1 px-0 text-sm font-medium hover:bg-transparent hover:text-primary"
                    disabled={running || pending}
                    onClick={() => void learn()}
                >
                    {running || pending ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        <GraduationCap className="size-4" />
                    )}
                    {running || pending ? i18n("Learning…") : i18n("Learn")}
                </Button>
            )}
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>{i18n("Review")}</DialogTitle>
                        <DialogDescription>
                            {i18n(
                                "What Learn found in this transcript. Ticked items are applied when you finish; unticked ones are not proposed again.",
                            )}
                        </DialogDescription>
                    </DialogHeader>

                    {groups.speakers.length > 0 && (
                        <section className="space-y-2">
                            <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                                {i18n("Speakers")}
                            </h3>
                            {groups.speakers.map((item) => {
                                const payload = item.payload as {
                                    label: string;
                                    personId: string | null;
                                    evidenceMs: number[];
                                    reason: string;
                                };
                                const person = payload.personId
                                    ? state?.names[payload.personId]
                                    : null;
                                return (
                                    <div
                                        key={item.id}
                                        className="flex items-start gap-2 text-sm"
                                    >
                                        {checkbox(
                                            item,
                                            i18n("Accept {label} as {name}", {
                                                label: payload.label,
                                                name: person ?? "?",
                                            }),
                                        )}
                                        <div className="min-w-0 space-y-0.5">
                                            <div>
                                                {payload.label} →{" "}
                                                {person ??
                                                    i18n("someone unknown")}
                                            </div>
                                            <div className="text-xs text-muted-foreground">
                                                {payload.reason}{" "}
                                                {payload.evidenceMs.map(
                                                    (ms) => (
                                                        <span
                                                            key={ms}
                                                            className="mr-1"
                                                        >
                                                            {seek(ms)}
                                                        </span>
                                                    ),
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </section>
                    )}

                    {groups.corrections.length > 0 && (
                        <section className="space-y-2">
                            <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                                {i18n("Corrections")}
                            </h3>
                            {groups.corrections.map((item) => {
                                const payload = item.payload as {
                                    kind: "correct" | "link";
                                    heard: string;
                                    target: Target;
                                    replacement: string | null;
                                    anchors: { turnIndex: number }[];
                                };
                                return (
                                    <div
                                        key={item.id}
                                        className="flex items-start gap-2 text-sm"
                                    >
                                        {checkbox(
                                            item,
                                            i18n("Correct {heard}", {
                                                heard: payload.heard,
                                            }),
                                        )}
                                        <div className="min-w-0">
                                            "{payload.heard}" ×
                                            {payload.anchors.length}{" "}
                                            {payload.kind === "link"
                                                ? `↔ ${nameOf(payload.target)} (${i18n("link, word kept")})`
                                                : `→ ${payload.replacement ?? nameOf(payload.target)}`}{" "}
                                            {payload.anchors
                                                .slice(0, 3)
                                                .map((anchor, index) => (
                                                    <span
                                                        key={`${anchor.turnIndex}:${index}`}
                                                        className="mr-1"
                                                    >
                                                        {seek(
                                                            turnStart(
                                                                anchor.turnIndex,
                                                            ),
                                                        )}
                                                    </span>
                                                ))}
                                        </div>
                                    </div>
                                );
                            })}
                        </section>
                    )}

                    {[
                        {
                            items: groups.known,
                            title: i18n("Known facts mentioned again"),
                        },
                        { items: groups.facts, title: i18n("New facts") },
                    ].map(
                        (group) =>
                            group.items.length > 0 && (
                                <section
                                    key={group.title}
                                    className="space-y-2"
                                >
                                    <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                                        {group.title}
                                    </h3>
                                    {group.items.map((item) => {
                                        const payload = item.payload as {
                                            subject: Side;
                                            relationKey: string;
                                            object: Side;
                                            startMs: number;
                                        };
                                        const relation =
                                            state?.relations[
                                                payload.relationKey
                                            ] ?? payload.relationKey;
                                        const text = `${nameOf(payload.subject)} — ${relation} — ${nameOf(payload.object)}`;
                                        return (
                                            <div
                                                key={item.id}
                                                className="flex items-start gap-2 text-sm"
                                            >
                                                {checkbox(item, text)}
                                                <div className="min-w-0">
                                                    {text}{" "}
                                                    {seek(payload.startMs)}
                                                    {item.dependsOnLabel && (
                                                        <div className="text-xs text-muted-foreground">
                                                            {i18n(
                                                                "needs {label} named",
                                                                {
                                                                    label: item.dependsOnLabel,
                                                                },
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </section>
                            ),
                    )}

                    {groups.phrases.length > 0 && (
                        <section className="space-y-2">
                            <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                                {i18n("New kind of relation")}
                            </h3>
                            {groups.phrases.map((item) => (
                                <PhraseItem
                                    key={item.id}
                                    item={item}
                                    types={state?.types ?? {}}
                                    describe={nameOf}
                                    onDecide={decide}
                                />
                            ))}
                        </section>
                    )}

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setOpen(false)}
                        >
                            {i18n("Save and continue later")}
                        </Button>
                        <Button
                            disabled={finishing}
                            onClick={() => void finish()}
                        >
                            {finishing && (
                                <Loader2 className="size-4 animate-spin" />
                            )}
                            {i18n("Finish review")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

/** A relation phrase: create it as the reviewer's own, suggest it, or dismiss it. */
function PhraseItem({
    item,
    types,
    describe,
    onDecide,
}: {
    item: ItemView;
    types: Record<string, string>;
    describe: (side: Side | undefined) => string;
    onDecide: (
        item: ItemView,
        decision: "accepted" | "rejected",
        choice?: Record<string, unknown> | null,
    ) => Promise<void>;
}) {
    const i18n = useExtracted();
    const payload = item.payload as {
        phrase: string;
        subject: Side;
        object: Side;
        count: number;
    };
    const [label, setLabel] = useState(payload.phrase);
    const typeOf = (side: Side): string | null => {
        if ("literal" in side) return null;
        if ("speakerLabel" in side) return "person";
        return (
            types["personId" in side ? side.personId : side.entityId] ?? null
        );
    };
    const subjectType = typeOf(payload.subject);
    const objectType = typeOf(payload.object);
    const chosen =
        item.decision === "accepted"
            ? (item.choice?.action as string | undefined)
            : item.decision === "rejected"
              ? "dismiss"
              : undefined;
    return (
        <div className="space-y-1 text-sm">
            <div>
                "{payload.phrase}" ({payload.count}×):{" "}
                {describe(payload.subject)} → {describe(payload.object)}
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    className="h-8 w-56"
                    value={label}
                    aria-label={i18n("Name of the relation")}
                    onChange={(event) => setLabel(event.target.value)}
                />
                <Button
                    size="sm"
                    variant={chosen === "create" ? "default" : "outline"}
                    disabled={!subjectType || !label.trim()}
                    onClick={() =>
                        void onDecide(item, "accepted", {
                            action: "create",
                            spec: {
                                label: label.trim(),
                                subjectTypes: [subjectType],
                                objectTypes: objectType ? [objectType] : [],
                                objectKind: objectType ? "entity" : "literal",
                                cardinality: "many",
                            },
                        })
                    }
                >
                    {i18n("Create as my relation")}
                </Button>
                <Button
                    size="sm"
                    variant={chosen === "suggest" ? "default" : "outline"}
                    onClick={() =>
                        void onDecide(item, "accepted", { action: "suggest" })
                    }
                >
                    {i18n("Suggest to Organization")}
                </Button>
                <Button
                    size="sm"
                    variant={chosen === "dismiss" ? "default" : "outline"}
                    onClick={() => void onDecide(item, "rejected", null)}
                >
                    {i18n("Dismiss")}
                </Button>
            </div>
        </div>
    );
}
