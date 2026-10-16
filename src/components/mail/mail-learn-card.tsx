"use client";

import { GraduationCap } from "lucide-react";
import { useExtracted } from "next-intl";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
    handleLearnReviewFailure,
    LearnEvidence,
    LearnOutcomeLine,
    LearnReviewRow,
    useLearnFinishFooter,
} from "@/components/learn/review-parts";
import {
    WorkflowWidget,
    WorkflowWidgetLine,
} from "@/components/pipeline/workflow-widget";
import { Button } from "@/components/ui/button";
import { getApiErrorMessage } from "@/lib/api-errors";
import type {
    MailFactPayload,
    MailNewRecordPayload,
    MailTextAnchor,
} from "@/lib/learn/mail-candidates";
import type { ReviewItemView, ReviewView } from "@/lib/learn/review";
import type { MailDetail } from "@/lib/mail/detail";
import type { WorkflowWidgetState } from "@/lib/pipeline/workflow-widgets";
import { cn } from "@/lib/utils";
import type { Recording } from "@/types/recording";

const POLL_MS = 3_000;

type Side =
    | { personId: string }
    | { entityId: string }
    | { newRef: string }
    | { speakerLabel: string }
    | { literal: string };

function isTicked(item: ReviewItemView): boolean {
    const decision =
        item.decision ?? (item.preTicked ? "accepted" : "rejected");
    return decision === "accepted";
}

/** Render and manage the Learn workflow for one mail. */
export function MailLearnCard({
    mail,
    detail,
    canChange,
    widget,
    widgetId,
}: {
    mail: Recording;
    detail: MailDetail;
    canChange: boolean;
    widget?: WorkflowWidgetState;
    widgetId: string;
}) {
    const i18n = useExtracted();
    const query = mail.view === "org" ? "?view=org" : "";
    const base = `/api/recordings/${encodeURIComponent(mail.id)}`;
    const [review, setReview] = useState<ReviewView | null>(null);
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState(false);

    const load = useCallback(async () => {
        const response = await fetch(`${base}/review${query}`).catch(
            () => null,
        );
        if (response?.ok) setReview((await response.json()) as ReviewView);
    }, [base, query]);

    useEffect(() => {
        setReview(null);
        void load();
    }, [load]);

    const status = review?.run?.status;
    const learning = status === "queued" || status === "running";
    useEffect(() => {
        if (!learning) return;
        const timer = setInterval(() => void load(), POLL_MS);
        return () => clearInterval(timer);
    }, [learning, load]);

    const start = async () => {
        setOpen(true);
        setBusy(true);
        try {
            const response = await fetch(`${base}/learn${query}`, {
                method: "POST",
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Learn could not start."),
                    ),
                );
                return;
            }
            await load();
        } finally {
            setBusy(false);
        }
    };

    const decide = async (item: ReviewItemView, accepted: boolean) => {
        const previous = review?.items.find(
            (candidate) => candidate.id === item.id,
        );
        setReview((current) => {
            if (!current) return current;
            return {
                ...current,
                items: current.items.map((candidate) => {
                    if (candidate.id !== item.id) return candidate;
                    return {
                        ...candidate,
                        decision: accepted ? "accepted" : "rejected",
                    };
                }),
            };
        });
        const maybe =
            item.kind === "new_record"
                ? (item.payload as unknown as MailNewRecordPayload).maybe
                : undefined;
        const response = await fetch(
            `${base}/review/items/${encodeURIComponent(item.id)}${query}`,
            {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    decision: accepted ? "accepted" : "rejected",
                    version: item.version,
                    ...(accepted && maybe ? { choice: maybe } : {}),
                }),
            },
        );
        if (!response.ok) {
            setReview((current) => {
                if (!current || !previous) return current;
                return {
                    ...current,
                    items: current.items.map((candidate) =>
                        candidate.id === item.id ? previous : candidate,
                    ),
                };
            });
            await handleLearnReviewFailure(
                response,
                i18n("The review changed; reload it."),
                load,
            );
            return;
        }
        const { version } = (await response.json()) as { version: number };
        setReview((current) => {
            if (!current) return current;
            return {
                ...current,
                items: current.items.map((candidate) => {
                    if (candidate.id !== item.id) return candidate;
                    return { ...candidate, version };
                }),
            };
        });
    };

    const finish = async () => {
        if (!review) return;
        setBusy(true);
        try {
            const response = await fetch(`${base}/review/finish${query}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    versions: Object.fromEntries(
                        review.items.map((item) => [item.id, item.version]),
                    ),
                }),
            });
            if (!response.ok) {
                await handleLearnReviewFailure(
                    response,
                    i18n("The review could not be finished."),
                    load,
                );
                return;
            }
            const finished = (await response.json()) as { applied: number };
            toast.success(
                i18n(
                    "{count, plural, one {# change made} other {# changes made}}",
                    { count: finished.applied },
                ),
            );
            await load();
        } finally {
            setBusy(false);
        }
    };

    const words = (anchor: MailTextAnchor | undefined) => {
        if (!anchor) return null;
        const segment = detail.segments.find(
            (candidate) => candidate.index === anchor.segmentIndex,
        );
        return segment?.text.slice(anchor.charStart, anchor.charEnd).trim();
    };
    const recordOf = (ref: string) =>
        review?.items.find(
            (item) =>
                item.kind === "new_record" &&
                (item.payload as unknown as MailNewRecordPayload).ref === ref,
        );
    const nameOf = (side: Side): string => {
        if ("literal" in side) return `“${side.literal}”`;
        if ("personId" in side) return review?.names[side.personId] ?? "?";
        if ("entityId" in side) return review?.names[side.entityId] ?? "?";
        if ("newRef" in side) {
            const record = recordOf(side.newRef);
            if (!record) return "?";
            return (record.payload as unknown as MailNewRecordPayload).name;
        }
        const participant = detail.participants.find(
            (candidate) => candidate.ref === side.speakerLabel,
        );
        return participant?.name ?? participant?.address ?? side.speakerLabel;
    };

    const items = (review?.items ?? []).filter(
        (item) => item.kind !== "relation_phrase",
    );
    const ready = status === "ready";
    const selected = items.filter(isTicked).length;
    const footer = useLearnFinishFooter({
        selected,
        total: items.length,
        busy,
        onFinish: () => void finish(),
    });

    if (!canChange || mail.mail?.autoGenerated || detail.unreadable) {
        return null;
    }

    const outcomeText = (outcome: string | null | undefined) => {
        switch (outcome) {
            case "applied":
                return i18n("Applied");
            case "rejected":
                return i18n("Left out");
            default:
                return i18n("Not applied");
        }
    };
    const provenanceText = (provenance: string | null | undefined) => {
        if (provenance === "quoted") {
            return i18n(
                "Quoted from an earlier message: what its author wrote, not the sender",
            );
        }
        if (provenance) return i18n("From a sender nothing verified");
        return null;
    };
    const itemContent = (item: ReviewItemView) => {
        let record: MailNewRecordPayload | null = null;
        let fact: MailFactPayload | null = null;
        if (item.kind === "new_record") {
            record = item.payload as unknown as MailNewRecordPayload;
        } else {
            fact = item.payload as unknown as MailFactPayload;
        }
        const quote = record ? words(record.evidence[0]) : words(fact?.text);
        let statement = null;
        if (record?.maybe) {
            statement = i18n("{name}: the same person as {known}?", {
                name: record.name,
                known: nameOf(record.maybe as Side),
            });
        } else if (record) {
            statement =
                record.kind === "person"
                    ? i18n("New person: {name}", { name: record.name })
                    : i18n("New thing: {name}", { name: record.name });
        } else if (fact) {
            statement = (
                <>
                    {nameOf(fact.subject as Side)}{" "}
                    <span className="text-muted-foreground">
                        {review?.relations[fact.relationKey] ??
                            fact.relationKey}
                    </span>{" "}
                    {nameOf(fact.object as Side)}
                </>
            );
        }
        return (
            <div className="space-y-1">
                <p>
                    {statement}
                    {record?.address && (
                        <span className="text-muted-foreground">
                            {" "}
                            · {record.address}
                        </span>
                    )}
                </p>
                <LearnEvidence
                    quote={quote}
                    provenance={provenanceText(fact?.provenance)}
                />
                {!ready && item.outcome && (
                    <LearnOutcomeLine>
                        {outcomeText(item.outcome)}
                    </LearnOutcomeLine>
                )}
            </div>
        );
    };

    const reviewBody = (
        <div className="space-y-3">
            {items.length > 1 && ready && (
                <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                        type="checkbox"
                        className="size-4"
                        checked={selected === items.length}
                        onChange={(event) => {
                            for (const item of items) {
                                if (isTicked(item) !== event.target.checked) {
                                    void decide(item, event.target.checked);
                                }
                            }
                        }}
                    />
                    {i18n("Apply all suggestions")}
                </label>
            )}
            {status === "finished" && review?.items.length === 0 && (
                <p className="text-sm text-muted-foreground">
                    {i18n("Learn found nothing new in this mail.")}
                </p>
            )}
            {status === "failed" && (
                <p className="text-sm text-destructive">
                    {i18n("Learn could not read this mail.")}
                </p>
            )}
            {items.length > 0 && (
                <ul className="space-y-2">
                    {items.map((item) => {
                        let kind: "new_record" | "fact" | "known_fact" = "fact";
                        if (item.kind === "new_record") kind = "new_record";
                        if (item.kind === "known_fact") kind = "known_fact";
                        return (
                            <li key={item.id}>
                                <LearnReviewRow
                                    kind={kind}
                                    checked={isTicked(item)}
                                    disabled={!ready || busy}
                                    checkboxLabel={i18n("Apply this")}
                                    onCheckedChange={
                                        ready
                                            ? (checked) =>
                                                  void decide(item, checked)
                                            : undefined
                                    }
                                    className={cn(
                                        "rounded-md border p-2",
                                        !ready && "opacity-80",
                                    )}
                                >
                                    {itemContent(item)}
                                </LearnReviewRow>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );

    const frame = widget?.frame ?? "inline";
    const tone = widget?.tone ?? (ready ? "review" : "quiet");
    const openReview = () => setOpen(true);
    let title = i18n("Learn");
    let description = i18n(
        "Choose what this message should teach the Almanac.",
    );
    if (ready) title = i18n("Review what Learn found");
    if (status === "finished") {
        title = i18n("Learn complete");
        description = i18n("The selected suggestions were applied.");
    } else if (status === "failed") {
        title = i18n("Learn failed");
        description = i18n("Learn could not read this mail.");
    }

    if (!ready && status !== "finished" && status !== "failed" && !learning) {
        return (
            <WorkflowWidgetLine
                id={widgetId}
                title={i18n("Learn")}
                facts={i18n("Ready when you are")}
                icon={<GraduationCap className="size-4" />}
                tone={tone}
                action={
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void start()}
                    >
                        {i18n("Learn")}
                    </Button>
                }
                onOpen={() => void start()}
            />
        );
    }

    let lineFacts = i18n("Learn is reading the message");
    let lineAction = i18n("View results");
    if (ready) {
        lineFacts = i18n(
            "{count, plural, one {# suggestion waits} other {# suggestions wait}} for your review",
            { count: items.length },
        );
        lineAction = i18n("Review");
    }
    const dialogLine = (
        <WorkflowWidgetLine
            title={ready ? i18n("Learn") : title}
            facts={lineFacts}
            icon={<GraduationCap className="size-4" />}
            tone={tone}
            working={learning}
            action={
                !learning ? (
                    <Button size="sm" onClick={openReview}>
                        {lineAction}
                    </Button>
                ) : undefined
            }
        />
    );
    let inlineLine: ReactNode;
    if (learning) {
        inlineLine = dialogLine;
    } else if ((status === "finished" || status === "failed") && !open) {
        inlineLine = (
            <WorkflowWidgetLine
                title={title}
                facts={description}
                icon={<GraduationCap className="size-4" />}
                tone={tone}
                expanded={false}
                onExpand={openReview}
                expandLabel={i18n("View results")}
            />
        );
    }

    return (
        <WorkflowWidget
            id={widgetId}
            frame={frame}
            tone={tone}
            open={open}
            onOpenChange={setOpen}
            title={title}
            description={description}
            footer={ready ? footer : undefined}
            dialogWidth="xl"
            dialogLine={dialogLine}
            inlineLine={inlineLine}
        >
            {learning ? (
                <p className="text-sm text-muted-foreground">
                    {i18n(
                        "Learn is reading the message. It continues in the background.",
                    )}
                </p>
            ) : (
                reviewBody
            )}
        </WorkflowWidget>
    );
}
