"use client";

import { Layers, User, Users } from "lucide-react";
import { useExtracted } from "next-intl";
import type { StatisticsScope } from "@/lib/statistics/data";
import { Segmented } from "./charts";
import styles from "./statistics.module.css";

export function StatisticsControls({
    scopes,
    scope,
    preset,
    onScope,
    onWarm,
    onPreset,
}: {
    scopes: StatisticsScope[];
    scope: StatisticsScope;
    preset: string;
    onScope: (scope: StatisticsScope) => void;
    onWarm: (scope: StatisticsScope) => void;
    onPreset: (preset: string) => void;
}) {
    const i18n = useExtracted();
    const scopeOptions = [
        {
            value: "mine" as const,
            label: i18n("Mine"),
            icon: <User aria-hidden="true" />,
        },
        {
            value: "organization" as const,
            label: i18n("Organization"),
            icon: <Users className="text-organization" aria-hidden="true" />,
        },
        {
            value: "everyone" as const,
            label: i18n("Everyone"),
            icon: <Layers aria-hidden="true" />,
        },
    ].filter((option) => scopes.includes(option.value));
    return (
        <div className={styles.controls}>
            {scopes.length > 1 && (
                <Segmented
                    label={i18n("Whose data")}
                    options={scopeOptions}
                    value={scope}
                    onChange={onScope}
                    onWarm={onWarm}
                />
            )}
            <Segmented
                label={i18n("Period")}
                options={[
                    { value: "30", label: i18n("30 days") },
                    { value: "90", label: i18n("90 days") },
                    { value: "365", label: i18n("Year") },
                ]}
                value={preset}
                onChange={onPreset}
            />
        </div>
    );
}
