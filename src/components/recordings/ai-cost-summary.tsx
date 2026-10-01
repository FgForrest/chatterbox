"use client";

import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";

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
            const response = await fetch(
                `/api/recordings/${encodeURIComponent(recordingId)}/ai-cost?view=${view ?? "private"}`,
            ).catch(() => null);
            if (!response?.ok) return;
            const data = (await response.json()) as CostSummary;
            if (active) setSummary(data);
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
        return (
            <span className="text-sm text-muted-foreground">
                {i18n("No AI spend tracked for this recording")}
            </span>
        );
    }
    const hasSubscriptionEstimate = [
        ...Object.keys(summary.byService),
        ...Object.keys(summary.unknownByService),
    ].some(
        (service) =>
            service.startsWith("Claude Code · ") ||
            service.startsWith("Codex · "),
    );
    return (
        <details className="relative text-sm text-muted-foreground">
            <summary className="cursor-pointer">
                {i18n("Estimated AI spend")}: {dollars(summary.totalUsd)}
                {summary.unknownCount > 0 ? ` + ${i18n("unknown")}` : ""}
            </summary>
            <div className="absolute z-20 mt-1 min-w-48 rounded-md border bg-popover p-3 shadow-md">
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
                {Object.entries(summary.byService).map(([service, amount]) => (
                    <div key={service} className="flex justify-between gap-4">
                        <span>{service}</span>
                        <span>{dollars(amount)}</span>
                    </div>
                ))}
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
            </div>
        </details>
    );
}
