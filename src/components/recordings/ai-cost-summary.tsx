"use client";

import { ChevronDown } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { MetadataSeparator } from "@/components/items/metadata-separator";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";

interface CostSummary {
    totalUsd: number;
    byOperation: Record<string, number>;
    byService: Record<string, number>;
    unknownByService: Record<string, number>;
    unknownCount: number;
    requestCount: number;
}

function dollars(amount: number): string {
    if (amount > 0 && amount < 0.0001) return "<$0.0001";
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
    }).format(amount);
}

export function AiCostSummary({
    recordingId,
    kind = "audio",
    view,
}: {
    recordingId: string;
    kind?: "audio" | "mail";
    view?: "private" | "org";
}) {
    const i18n = useExtracted();
    const [summary, setSummary] = useState<CostSummary | null>(null);

    useEffect(() => {
        let active = true;
        const load = async () => {
            if (document.visibilityState === "hidden") return;
            try {
                const response = await fetch(
                    `/api/recordings/${encodeURIComponent(recordingId)}/ai-cost?view=${view ?? "private"}`,
                );
                if (!response.ok) return;
                const data = (await response.json()) as CostSummary;
                if (active) setSummary(data);
            } catch {
                return;
            }
        };
        void load();
        const timer = window.setInterval(() => void load(), 30_000);
        return () => {
            active = false;
            window.clearInterval(timer);
        };
    }, [recordingId, view]);

    if (!summary) return null;
    if (summary.requestCount === 0) {
        const emptyLabel =
            kind === "mail"
                ? i18n("No AI spend tracked for this mail")
                : i18n("No AI spend tracked for this recording");
        return (
            <span className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap">
                <MetadataSeparator />
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            type="button"
                            aria-label={emptyLabel}
                            className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            $??
                        </button>
                    </TooltipTrigger>
                    <TooltipContent>{emptyLabel}</TooltipContent>
                </Tooltip>
            </span>
        );
    }
    const hasPricedTotal =
        summary.requestCount > summary.unknownCount &&
        Number.isFinite(summary.totalUsd);
    const total = hasPricedTotal ? dollars(summary.totalUsd) : "$??";
    const label = `${i18n("Estimated AI spend")}: ${total}`;
    const hasSubscriptionEstimate = [
        ...Object.keys(summary.byService),
        ...Object.keys(summary.unknownByService),
    ].some(
        (service) =>
            service.startsWith("Claude Code · ") ||
            service.startsWith("Codex · "),
    );
    return (
        <span className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap">
            <MetadataSeparator />
            <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        aria-label={label}
                        aria-haspopup="dialog"
                        className="inline-flex items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        {total}
                        {hasPricedTotal && summary.unknownCount > 0 && " + ?"}
                        <ChevronDown className="size-3" aria-hidden="true" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    align="end"
                    role="dialog"
                    aria-orientation={undefined}
                    aria-label={i18n("Estimated AI spend")}
                    className="max-h-(--radix-dropdown-menu-content-available-height) w-80 max-w-[calc(100vw-2rem)] overflow-y-auto p-3 text-sm text-muted-foreground"
                >
                    <p className="mb-2 font-medium">{label}</p>
                    {Object.entries(summary.byOperation).map(
                        ([operation, amount]) => (
                            <div
                                key={operation}
                                className="flex justify-between gap-4"
                            >
                                <span className="capitalize">{operation}</span>
                                <span>{dollars(amount)}</span>
                            </div>
                        ),
                    )}
                    <div className="my-2 border-t" />
                    {Object.entries(summary.byService).map(
                        ([service, amount]) => (
                            <div
                                key={service}
                                className="flex justify-between gap-4"
                            >
                                <span>{service}</span>
                                <span>{dollars(amount)}</span>
                            </div>
                        ),
                    )}
                    {Object.entries(summary.unknownByService).map(
                        ([service, count]) => (
                            <div
                                key={service}
                                className="flex justify-between gap-4"
                            >
                                <span>{service}</span>
                                <span>
                                    {count} {i18n("unpriced")}
                                </span>
                            </div>
                        ),
                    )}
                    {summary.unknownCount > 0 && (
                        <p className="mt-2 text-xs">
                            {i18n(
                                "Some requests lack usable cost data; the total is incomplete.",
                            )}
                        </p>
                    )}
                    {hasSubscriptionEstimate && (
                        <p className="mt-2 text-xs">
                            {i18n(
                                "Claude Code and Codex amounts estimate equivalent API usage, not subscription charges.",
                            )}
                        </p>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
        </span>
    );
}
