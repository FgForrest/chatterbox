"use client";

import { useExtracted } from "next-intl";
import { useState } from "react";
import { useProductName } from "@/components/product-name-provider";
import {
    type DayRange,
    type StatisticsData,
    type StatisticsScope,
    sliceRange,
} from "@/lib/statistics/data";
import { KnowledgeSections, PeopleSection } from "./insight-sections";
import { ActivitySections, RecordedTime } from "./recording-sections";
import {
    ModelsSection,
    SpendSection,
    StorageSection,
} from "./spending-sections";
import styles from "./statistics.module.css";
import { StatisticsControls } from "./statistics-controls";
import { useStatisticsData } from "./use-statistics-data";
import { useStatisticsView } from "./use-statistics-view";

export function StatisticsPage({
    initialData,
    scopes,
}: {
    initialData: StatisticsData;
    scopes: StatisticsScope[];
}) {
    const i18n = useExtracted();
    const name = useProductName();
    const { data, scope, loading, failed, selectScope, warmScope } =
        useStatisticsData(initialData);
    const [range, setRange] = useState<DayRange>({
        start: initialData.days - 90,
        end: initialData.days - 1,
    });
    const [preset, setPreset] = useState("90");
    const view = useStatisticsView(data, range);
    return (
        <div className={styles.statistics}>
            <div className={styles.pagehead}>
                <div>
                    <h1>{i18n("Statistics")}</h1>
                    <p>
                        {i18n(
                            "How much {name} has recorded, transcribed and summarized, what it cost and how much space it takes.",
                            { name },
                        )}
                    </p>
                </div>
                <StatisticsControls
                    scopes={scopes}
                    scope={scope}
                    preset={preset}
                    onScope={(next) => {
                        void selectScope(next);
                    }}
                    onWarm={warmScope}
                    onPreset={(value) => {
                        setPreset(value);
                        setRange({
                            start: data.days - Number(value),
                            end: data.days - 1,
                        });
                    }}
                />
            </div>
            {failed && (
                <p role="alert" className={styles.error}>
                    {i18n(
                        "Could not load statistics. The previous view is still shown.",
                    )}{" "}
                    <button
                        type="button"
                        onClick={() => {
                            void selectScope(scope);
                        }}
                    >
                        {i18n("Retry")}
                    </button>
                </p>
            )}
            {data.scope === "everyone" && (
                <p className={styles.scopeNote}>
                    {i18n(
                        "Everyone includes private items as numbers only. The ranking is visible to every signed-in member.",
                    )}
                </p>
            )}
            <div aria-busy={loading} style={{ opacity: loading ? 0.5 : 1 }}>
                <RecordedTime
                    view={view}
                    onRange={(next) => {
                        setRange(sliceRange(next.start, next.end, data.days));
                        setPreset("");
                    }}
                />
                <div className={styles.grid}>
                    <ActivitySections view={view} />
                    <SpendSection view={view} />
                    <StorageSection view={view} />
                    <ModelsSection view={view} />
                    <PeopleSection
                        view={view}
                        scopes={scopes}
                        selectScope={selectScope}
                    />
                    <KnowledgeSections view={view} />
                </div>
            </div>
        </div>
    );
}
