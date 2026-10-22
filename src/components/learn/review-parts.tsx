"use client";

import { Loader2 } from "lucide-react";
import { useExtracted } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import type { WorkflowWidgetFooter } from "@/components/pipeline/workflow-widget";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface LearnReviewRowProps {
    kind:
        | "new_record"
        | "fact"
        | "known_fact"
        | "correction"
        | "relation_phrase";
    checked?: boolean;
    checkboxLabel?: string;
    disabled?: boolean;
    blockedReason?: string | null;
    onCheckedChange?: (checked: boolean) => void;
    children: ReactNode;
    className?: string;
}

/** Render a selectable Learn record or fact row shared by recording and mail reviews. */
export function LearnReviewRow({
    kind,
    checked,
    checkboxLabel,
    disabled = false,
    blockedReason,
    onCheckedChange,
    children,
    className,
}: LearnReviewRowProps) {
    const [showReason, setShowReason] = useState(false);
    const reasonId = useId();
    return (
        <div
            className={cn(
                "flex items-start gap-3 rounded-lg bg-muted p-3 text-sm dark:bg-popover",
                className,
            )}
            data-shared-learn-row={kind}
        >
            {onCheckedChange && (
                <input
                    type="checkbox"
                    className="mt-1 size-4 shrink-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                    checked={checked ?? false}
                    disabled={disabled}
                    aria-disabled={blockedReason ? true : undefined}
                    aria-describedby={
                        showReason && blockedReason ? reasonId : undefined
                    }
                    title={blockedReason ?? undefined}
                    aria-label={checkboxLabel}
                    onClick={() => {
                        if (blockedReason) setShowReason(true);
                    }}
                    onKeyDown={(event) => {
                        if (blockedReason && event.key === " ") {
                            event.preventDefault();
                            setShowReason(true);
                        }
                    }}
                    onChange={(event) => {
                        if (!blockedReason)
                            onCheckedChange(event.target.checked);
                    }}
                />
            )}
            <div className="min-w-0 flex-1">
                {children}
                {showReason && blockedReason && (
                    <p
                        id={reasonId}
                        role="alert"
                        className="mt-1 text-xs text-destructive"
                    >
                        {blockedReason}
                    </p>
                )}
            </div>
        </div>
    );
}

interface LearnEvidenceProps {
    quote?: ReactNode;
    provenance?: ReactNode;
    children?: ReactNode;
}

/** Render supporting words, playback links, and provenance for a Learn item. */
export function LearnEvidence({
    quote,
    provenance,
    children,
}: LearnEvidenceProps) {
    const i18n = useExtracted();
    const [expanded, setExpanded] = useState(false);
    const quoteId = useId();
    return (
        <div data-shared-learn-evidence>
            {children}
            {provenance && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                    {provenance}
                </p>
            )}
            {quote && (
                <div className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
                    <p
                        id={quoteId}
                        className={cn(
                            "min-w-0 italic",
                            expanded ? "break-words" : "truncate",
                        )}
                    >
                        “{quote}”
                    </p>
                    <button
                        type="button"
                        className="shrink-0 underline underline-offset-2"
                        aria-controls={quoteId}
                        aria-expanded={expanded}
                        onClick={() => setExpanded((value) => !value)}
                    >
                        {expanded ? i18n("Shorten") : i18n("Full quote")}
                    </button>
                </div>
            )}
        </div>
    );
}

/** Render the read-only result of applying one Learn suggestion. */
export function LearnOutcomeLine({ children }: { children: ReactNode }) {
    return (
        <p className="text-xs text-muted-foreground" data-shared-learn-outcome>
            {children}
        </p>
    );
}

interface LearnFinishFooterOptions {
    selected: number;
    total: number;
    busy: boolean;
    onFinish: () => void;
}

/** Report a rejected Learn review write, then reload its current state. */
export async function handleLearnReviewFailure(
    response: Response,
    fallbackMessage: string,
    reload: () => Promise<unknown>,
    errorMessage: (response: Response, fallback: string) => Promise<string>,
): Promise<void> {
    toast.error(await errorMessage(response, fallbackMessage));
    await reload();
}

/** Build the common Learn review status and finish action. */
export function useLearnFinishFooter({
    selected,
    total,
    busy,
    onFinish,
}: LearnFinishFooterOptions): WorkflowWidgetFooter {
    const i18n = useExtracted();
    return {
        status: i18n("{selected} of {total} will be applied", {
            selected: String(selected),
            total: String(total),
        }),
        actions: (
            <Button type="button" disabled={busy} onClick={onFinish}>
                {busy && (
                    <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                )}
                {i18n("Finish review")}
            </Button>
        ),
    };
}
