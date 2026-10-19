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
import type { AiCostPayer, recordingAiCost } from "@/lib/ai/usage-cost";

type CostSummary = Awaited<ReturnType<typeof recordingAiCost>>;

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
    view,
}: {
    recordingId: string;
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

    if (!summary || summary.requestCount === 0) return null;
    const hasPricedTotal =
        summary.requestCount > summary.unknownCount &&
        Number.isFinite(summary.totalUsd);
    const partlyUnpriced = hasPricedTotal && summary.unknownCount > 0;
    let total = i18n("unpriced");
    let spoken = i18n("no price available");
    if (hasPricedTotal) {
        total = partlyUnpriced
            ? `≥ ${dollars(summary.totalUsd)}`
            : dollars(summary.totalUsd);
        spoken = partlyUnpriced
            ? i18n("at least {amount}", { amount: dollars(summary.totalUsd) })
            : total;
    }
    const label = `${i18n("Estimated AI spend")}: ${spoken}`;
    const hasSubscriptionEstimate = [
        ...Object.keys(summary.byService),
        ...Object.keys(summary.unknownByService),
    ].some(
        (service) =>
            service.startsWith("Claude Code · ") ||
            service.startsWith("Codex · "),
    );
    const singlePayer =
        summary.payers.length === 1 ? summary.payers[0].payer : null;
    const breakdowns =
        summary.payers.length > 1
            ? summary.payers
            : [{ ...summary, payer: null }];
    function payerLabel(payer: AiCostPayer): string {
        if (payer.type === "you") return i18n("you");
        if (payer.type === "organization") return i18n("Organization");
        return payer.name ?? i18n("another member");
    }
    function payerSuffix(payer: AiCostPayer | null, className: string) {
        if (!payer) return null;
        return <span className={className}>· {payerLabel(payer)}</span>;
    }
    function payerSentence(payer: AiCostPayer): string {
        if (payer.type === "you") return i18n("Paid by you.");
        if (payer.type === "organization")
            return i18n("Paid by the Organization.");
        return payer.name
            ? i18n("Paid by {name}.", { name: payer.name })
            : i18n("Paid by another member.");
    }
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
                    {singlePayer && (
                        <p className="mb-2 text-xs">
                            {payerSentence(singlePayer)}
                        </p>
                    )}
                    {breakdowns.flatMap(({ payer, byOperation }, index) =>
                        Object.entries(byOperation).map(
                            ([operation, amount]) => (
                                <div
                                    key={`${index}:${operation}`}
                                    className="flex justify-between gap-4"
                                >
                                    <span className="capitalize">
                                        {operation}
                                        {payerSuffix(
                                            payer,
                                            "ml-1 normal-case opacity-70",
                                        )}
                                    </span>
                                    <span>{dollars(amount)}</span>
                                </div>
                            ),
                        ),
                    )}
                    <div className="my-2 border-t" />
                    {breakdowns.flatMap(({ payer, byService }, index) =>
                        Object.entries(byService).map(([service, amount]) => (
                            <div
                                key={`${index}:${service}`}
                                className="flex justify-between gap-4"
                            >
                                <span>
                                    {service}
                                    {payerSuffix(payer, "ml-1 opacity-70")}
                                </span>
                                <span>{dollars(amount)}</span>
                            </div>
                        )),
                    )}
                    {breakdowns.flatMap(({ payer, unknownByService }, index) =>
                        Object.entries(unknownByService).map(
                            ([service, count]) => (
                                <div
                                    key={`${index}:${service}`}
                                    className="flex justify-between gap-4"
                                >
                                    <span>
                                        {service}
                                        {payerSuffix(payer, "ml-1 opacity-70")}
                                    </span>
                                    <span>
                                        {count} {i18n("unpriced")}
                                    </span>
                                </div>
                            ),
                        ),
                    )}
                    {partlyUnpriced && (
                        <p className="mt-2 text-xs">
                            {i18n(
                                "Some requests lack usable cost data; the total is incomplete.",
                            )}
                        </p>
                    )}
                    {!hasPricedTotal && (
                        <p className="mt-2 text-xs">
                            {i18n(
                                "No request has usable cost data, so there is no total.",
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
