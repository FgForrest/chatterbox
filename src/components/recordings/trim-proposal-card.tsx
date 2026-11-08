"use client";

import { Scissors } from "lucide-react";
import { useExtracted, useFormatter } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTimeZone } from "use-intl/react";
import { WorkflowWidget } from "@/components/pipeline/workflow-widget";
import { useHostedDeployment } from "@/components/product-name-provider";
import { useRecordingCut } from "@/components/recordings/recording-cut";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import { trimRange } from "@/lib/recordings/trim-proposal";
import { formatClock } from "@/lib/topics/timeline";

export function TrimProposalCard({
    processing,
    userId,
}: {
    processing: ItemProcessingPresentation | null;
    userId?: string;
}) {
    const cut = useRecordingCut();
    const identity = processing?.trimProposal
        ? `${processing.itemId}:${processing.trimProposal.id}:${processing.trimProposal.transcript.revision}`
        : "";
    const previousIdentity = useRef(identity);
    useEffect(() => {
        if (
            previousIdentity.current &&
            previousIdentity.current !== identity &&
            cut?.open &&
            !cut.cutting
        )
            cut.cancel();
        previousIdentity.current = identity;
    }, [cut, identity]);
    if (
        !cut?.owner ||
        !processing ||
        (!processing.trimProposal &&
            !["failed", "skipped"].includes(
                processing.phases.trim?.state ?? "",
            ))
    )
        return null;
    return <TrimProposalBody processing={processing} userId={userId} />;
}

function TrimProposalBody({
    processing,
    userId,
}: {
    processing: ItemProcessingPresentation;
    userId?: string;
}) {
    const proposal = processing?.trimProposal;
    const cut = useRecordingCut();
    const i18n = useExtracted();
    const format = useFormatter();
    const timeZone = useTimeZone() ?? "UTC";
    const hosted = useHostedDeployment();
    const [selected, setSelected] = useState({ start: true, end: true });
    const [dismissed, setDismissed] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const identity = proposal ? `${processing?.itemId}:${proposal.id}` : "";
    const [shown, setShown] = useState(identity);
    if (shown !== identity) {
        setShown(identity);
        setSelected({ start: true, end: true });
        setDismissed(null);
    }
    const visible = Boolean(
        cut?.owner && proposal && proposal.id !== dismissed,
    );
    const setPreview = cut?.setProposalPreview;
    useEffect(() => {
        setPreview?.(
            visible && proposal
                ? trimRange(proposal, proposal.audio.duration, selected)
                : null,
        );
        return () => setPreview?.(null);
    }, [proposal, selected, visible, setPreview]);
    const retry = async () => {
        setSaving(true);
        try {
            const response = await fetch(
                `/api/recordings/${processing.itemId}/process-again`,
                { method: "POST" },
            );
            if (!response.ok) throw new Error("retry_failed");
            invalidateItemProcessing(processing.itemId);
        } catch {
            toast.error(i18n("Processing could not start. Try again."));
        } finally {
            setSaving(false);
        }
    };
    if (!cut?.owner) return null;
    if (!proposal) {
        const phase = processing?.phases.trim;
        if (
            !phase ||
            !["skipped", "failed"].includes(phase.state) ||
            ["profile_off", "manual_only", "gone", "outdated"].includes(
                phase.reason ?? "",
            )
        )
            return null;
        return (
            <output className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                {phase.reason === "context_limit"
                    ? i18n(
                          "Trim proposal skipped: the whole transcript exceeds the model context or input limit. Choose a longer-context provider and process again.",
                      )
                    : phase.reason === "invalid_output"
                      ? i18n(
                            "Trim proposal skipped: the AI response did not describe safe sentence boundaries. Processing continues without a cut.",
                        )
                      : i18n(
                            "Trim proposal could not run. Processing continues without a cut. Check the trim provider before processing again.",
                        )}
                <Button
                    className="ml-3"
                    variant="outline"
                    size="sm"
                    disabled={saving}
                    onClick={() => void retry()}
                >
                    {i18n("Try trim proposal again")}
                </Button>
            </output>
        );
    }
    if (!visible) return null;
    const open = (confirm: boolean) =>
        cut.openWithRange({
            range: trimRange(proposal, proposal.audio.duration, selected),
            revisions: proposal.revisions,
            proposalId: proposal.id,
            source: proposal.transcript.source,
            confirm,
        });
    const decline = async () => {
        setDismissed(proposal.id);
        setSaving(true);
        try {
            const response = await fetch(
                `/api/recordings/${processing?.itemId}/trim-proposal`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ proposalId: proposal.id }),
                },
            );
            if (!response.ok) throw new Error("decision_failed");
            invalidateItemProcessing(processing?.itemId ?? "");
        } catch {
            setDismissed(null);
            toast.error(
                i18n(
                    "The trim decision could not be saved. Reload the recording and try again.",
                ),
            );
        } finally {
            setSaving(false);
        }
    };
    const runManual = async (step: "learn" | "summary") => {
        setSaving(true);
        try {
            const response = await fetch(
                `/api/recordings/${processing?.itemId}/${step}?source=${encodeURIComponent(proposal.transcript.source)}&view=private`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: "{}",
                },
            );
            if (!response.ok) throw new Error("manual_failed");
            setDismissed(proposal.id);
            invalidateItemProcessing(processing?.itemId ?? "");
        } catch {
            toast.error(
                i18n(
                    "Processing could not start. The trim proposal is still available.",
                ),
            );
        } finally {
            setSaving(false);
        }
    };
    return (
        <section
            id={`recording-trim-${processing?.itemId}`}
            tabIndex={-1}
            aria-label={i18n("Trim off-topic talk?")}
        >
            <WorkflowWidget
                id={`recording-trim-body-${processing?.itemId}`}
                frame="inline"
                tone="review"
                title={
                    <>
                        <Scissors className="size-4 text-amber-700 dark:text-amber-400" />
                        {i18n("Trim off-topic talk?")}
                    </>
                }
                bodyClassName="space-y-3 bg-amber-500/5"
            >
                <p className="text-sm">
                    {proposal.start && proposal.end
                        ? i18n(
                              "The beginning and end probably contain conversation unrelated to the meeting. You can trim it before Learn and summary processing starts. The proposed parts are marked in the transcript.",
                          )
                        : proposal.start
                          ? i18n(
                                "The beginning probably contains conversation unrelated to the meeting. You can trim it before Learn and summary processing starts. The proposed part is marked in the transcript.",
                            )
                          : i18n(
                                "The end probably contains conversation unrelated to the meeting. You can trim it before Learn and summary processing starts. The proposed part is marked in the transcript.",
                            )}
                </p>
                {(["start", "end"] as const).map((edge) => {
                    const value = proposal[edge];
                    if (!value) return null;
                    const from = edge === "start" ? 0 : value.startMs;
                    const to =
                        edge === "start"
                            ? value.startMs
                            : proposal.audio.duration;
                    const label =
                        edge === "start" ? i18n("Beginning") : i18n("End");
                    return (
                        <label
                            htmlFor={`trim-${proposal.id}-${edge}`}
                            key={edge}
                            className="flex cursor-pointer items-start gap-3 rounded-md border border-amber-500/20 p-3"
                        >
                            <Input
                                type="checkbox"
                                className="mt-1 size-4 accent-amber-600"
                                id={`trim-${proposal.id}-${edge}`}
                                checked={selected[edge]}
                                onChange={(event) =>
                                    setSelected((previous) => ({
                                        ...previous,
                                        [edge]: event.target.checked,
                                    }))
                                }
                                aria-label={label}
                            />
                            <span className="text-sm">
                                <span className="font-medium">
                                    {label} {formatClock(from)}–
                                    {formatClock(to)}
                                </span>
                                <span className="ml-2 text-muted-foreground">
                                    {i18n("{minutes} min {seconds} s", {
                                        minutes: String(
                                            Math.floor((to - from) / 60000),
                                        ),
                                        seconds: String(
                                            Math.floor(
                                                ((to - from) % 60000) / 1000,
                                            ),
                                        ),
                                    })}
                                </span>
                                <span className="block">{value.reason}</span>
                            </span>
                        </label>
                    );
                })}
                <p className="text-xs text-muted-foreground">
                    {i18n(
                        "Without a decision, processing continues without a cut at {deadline}.",
                        {
                            deadline: format.dateTime(
                                new Date(proposal.deadline),
                                {
                                    hour: "numeric",
                                    minute: "2-digit",
                                    timeZone,
                                },
                            ),
                        },
                    )}
                </p>
                <p className="text-xs text-muted-foreground">
                    {i18n("{minutes} minutes remaining", {
                        minutes: String(
                            Math.max(
                                0,
                                Math.ceil(
                                    (Date.parse(proposal.deadline) -
                                        (Date.parse(
                                            processing?.nextCheckAt ?? "",
                                        ) - (processing?.nextCheckInMs ?? 0) ||
                                            Date.now())) /
                                        60000,
                                ),
                            ),
                        ),
                    })}
                </p>
                <p className="text-xs text-muted-foreground">
                    {i18n(
                        "Running Learn or a summary yourself skips this proposal and continues uncut.",
                    )}
                </p>
                <div className="flex flex-wrap gap-2">
                    <Button
                        size="sm"
                        onClick={() => open(true)}
                        disabled={
                            saving ||
                            cut.disabledReason !== null ||
                            !(
                                (selected.start && proposal.start) ||
                                (selected.end && proposal.end)
                            )
                        }
                    >
                        {i18n("Cut selected…")}
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => open(false)}
                        disabled={saving || cut.disabledReason !== null}
                    >
                        {i18n("Adjust in transcript")}
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void decline()}
                        disabled={saving || cut.cutting}
                    >
                        {i18n("Do not trim")}
                    </Button>
                </div>
                <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">
                        {i18n("Process without trimming")}
                    </summary>
                    <div className="mt-2 flex flex-wrap gap-2">
                        {!hosted && proposal.transcript.source !== "mixed" && (
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={saving || cut.cutting}
                                onClick={() => void runManual("learn")}
                            >
                                {i18n("Run Learn without trimming")}
                            </Button>
                        )}
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={saving || cut.cutting}
                            onClick={() => void runManual("summary")}
                        >
                            {i18n("Summarize without trimming")}
                        </Button>
                    </div>
                </details>
                <p className="text-xs text-muted-foreground">
                    {i18n(
                        "Suggested by {provider} · {model}. Paid by {payer}.",
                        {
                            provider: proposal.provider.provider,
                            model: proposal.provider.model,
                            payer:
                                proposal.provider.payerUserId === userId
                                    ? i18n("you")
                                    : i18n("the Organization"),
                        },
                    )}
                </p>
            </WorkflowWidget>
        </section>
    );
}
