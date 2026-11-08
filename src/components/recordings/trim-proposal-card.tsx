"use client";

import { Scissors } from "lucide-react";
import { useExtracted, useFormatter } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTimeZone } from "use-intl/react";
import { WorkflowWidget } from "@/components/pipeline/workflow-widget";
import { useProductName } from "@/components/product-name-provider";
import { useRecordingCut } from "@/components/recordings/recording-cut";
import { Button } from "@/components/ui/button";
import { getPasswordManagerAttributes } from "@/lib/password-manager";
import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import {
    type StoredTrimProposal,
    trimRange,
} from "@/lib/recordings/trim-proposal";
import { formatClock } from "@/lib/topics/timeline";

const SILENT_SKIP_REASONS = new Set([
    "profile_off",
    "manual_only",
    "gone",
    "outdated",
    "no_provider",
    "unsupported_cut",
]);

function showsTrimNotice(processing: ItemProcessingPresentation): boolean {
    const phase = processing.phases.trim;
    return Boolean(
        processing.trimProposal ||
            (phase &&
                ["failed", "skipped"].includes(phase.state) &&
                !SILENT_SKIP_REASONS.has(phase.reason ?? "")),
    );
}

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
    if (!cut?.owner || !processing || !showsTrimNotice(processing)) return null;
    return <TrimProposalBody processing={processing} userId={userId} />;
}

function TrimProposalBody({
    processing,
    userId,
}: {
    processing: ItemProcessingPresentation;
    userId?: string;
}) {
    const proposal = processing.trimProposal;
    const cut = useRecordingCut();
    const i18n = useExtracted();
    const format = useFormatter();
    const timeZone = useTimeZone() ?? "UTC";
    const product = useProductName();
    // The message extractor only sees i18n calls inside the component that owns useExtracted.
    const skipMessage = (reason: string | undefined) => {
        switch (reason) {
            case "context_limit":
                return i18n(
                    "Trim proposal skipped: the whole transcript exceeds the model context or input limit. Choose a longer-context provider and process again.",
                );
            case "invalid_output":
                return i18n(
                    "Trim proposal skipped: the AI response did not describe safe sentence boundaries. Processing continues without a cut.",
                );
            default:
                return i18n(
                    "Trim proposal could not run. Processing continues without a cut. Check the trim provider before processing again.",
                );
        }
    };
    const proposalDescription = (edges: StoredTrimProposal) => {
        if (edges.start && edges.end)
            return i18n(
                "The beginning and end probably contain conversation unrelated to the meeting. You can trim it before Learn and summary processing starts. The proposed parts are marked in the transcript.",
            );
        if (edges.start)
            return i18n(
                "The beginning probably contains conversation unrelated to the meeting. You can trim it before Learn and summary processing starts. The proposed part is marked in the transcript.",
            );
        return i18n(
            "The end probably contains conversation unrelated to the meeting. You can trim it before Learn and summary processing starts. The proposed part is marked in the transcript.",
        );
    };
    const [selected, setSelected] = useState({ start: true, end: true });
    const [dismissed, setDismissed] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const identity = proposal ? `${processing.itemId}:${proposal.id}` : "";
    const [shown, setShown] = useState(identity);
    if (shown !== identity) {
        setShown(identity);
        setSelected({ start: true, end: true });
        setDismissed(null);
    }
    const visible = Boolean(proposal && proposal.id !== dismissed);
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
    if (!cut) return null;
    if (!proposal) {
        const phase = processing.phases.trim;
        if (!showsTrimNotice(processing)) return null;
        return (
            <output className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                {skipMessage(phase?.reason)}
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
                `/api/recordings/${processing.itemId}/trim-proposal`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ proposalId: proposal.id }),
                },
            );
            if (!response.ok) throw new Error("decision_failed");
            invalidateItemProcessing(processing.itemId);
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
    return (
        <section
            id={`recording-trim-${processing.itemId}`}
            tabIndex={-1}
            aria-label={i18n("Trim off-topic talk?")}
        >
            <WorkflowWidget
                id={`recording-trim-body-${processing.itemId}`}
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
                <p className="text-sm">{proposalDescription(proposal)}</p>
                {(["start", "end"] as const).map((edge) => (
                    <TrimEdgeRow
                        key={edge}
                        proposal={proposal}
                        edge={edge}
                        selected={selected[edge]}
                        onChange={(checked) =>
                            setSelected((previous) => ({
                                ...previous,
                                [edge]: checked,
                            }))
                        }
                    />
                ))}
                <p className="text-xs text-muted-foreground">
                    {i18n(
                        "Without a decision, {product} continues without a cut at {time}. You can still cut later; Learn and the summary then run again.",
                        {
                            product,
                            time: format.dateTime(new Date(proposal.deadline), {
                                hour: "numeric",
                                minute: "2-digit",
                                timeZone,
                            }),
                        },
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
                <p className="text-xs text-muted-foreground">
                    {proposal.provider.payerUserId === userId
                        ? i18n(
                              "Suggested by {provider} · {model}. You pay for it.",
                              {
                                  provider: proposal.provider.provider,
                                  model: proposal.provider.model,
                              },
                          )
                        : i18n(
                              "Suggested by {provider} · {model}. The Organization pays for it.",
                              {
                                  provider: proposal.provider.provider,
                                  model: proposal.provider.model,
                              },
                          )}
                </p>
            </WorkflowWidget>
        </section>
    );
}

function TrimEdgeRow({
    proposal,
    edge,
    selected,
    onChange,
}: {
    proposal: StoredTrimProposal;
    edge: "start" | "end";
    selected: boolean;
    onChange: (checked: boolean) => void;
}) {
    const i18n = useExtracted();
    const value = proposal[edge];
    if (!value) return null;
    const from = edge === "start" ? 0 : value.startMs;
    const to = edge === "start" ? value.startMs : proposal.audio.duration;
    const label = edge === "start" ? i18n("Beginning") : i18n("End");
    return (
        <label
            htmlFor={`trim-${proposal.id}-${edge}`}
            className="flex cursor-pointer items-start gap-3 rounded-md border border-amber-500/20 p-3"
        >
            <input
                {...getPasswordManagerAttributes()}
                type="checkbox"
                className="mt-1 size-4 accent-amber-600"
                id={`trim-${proposal.id}-${edge}`}
                checked={selected}
                onChange={(event) => onChange(event.target.checked)}
            />
            <span className="text-sm">
                <span className="font-medium">
                    {label} {formatClock(from)}–{formatClock(to)}
                </span>
                <span className="ml-2 text-muted-foreground">
                    {i18n("{minutes} min {seconds} s", {
                        minutes: String(Math.floor((to - from) / 60000)),
                        seconds: String(
                            Math.floor(((to - from) % 60000) / 1000),
                        ),
                    })}
                </span>
                <span className="block">{value.reason}</span>
            </span>
        </label>
    );
}
