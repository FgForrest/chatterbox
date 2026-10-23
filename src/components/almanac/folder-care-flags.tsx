"use client";

import { useExtracted } from "next-intl";
import { useState } from "react";
import { CareProblemCard } from "@/components/almanac/care-problem-card";
import { DuplicateFixCard } from "@/components/almanac/duplicate-fix-card";
import { FolderShareFix } from "@/components/almanac/folder-share-fix";
import type { FolderCare } from "@/lib/knowledge/folder-care";

export function FolderCareFlags({
    care,
    recordId,
    factId,
    onChanged,
}: {
    care?: FolderCare;
    recordId?: string;
    factId?: string;
    onChanged: () => void;
}) {
    const i18n = useExtracted();
    const [hidden, setHidden] = useState(new Set<string>());
    const problems =
        care?.problems.filter(
            (problem) =>
                !hidden.has(problem.key) &&
                (problem.records.some((record) => record.id === recordId) ||
                    problem.options.some((option) => option.id === factId)),
        ) ?? [];
    const duplicates =
        care?.duplicates.filter(
            (pair) =>
                !hidden.has(pair.key) &&
                (pair.left.id === recordId || pair.right.id === recordId),
        ) ?? [];
    const shares =
        care?.shareRefs?.filter((ref) =>
            ref.kind === "record" ? ref.id === recordId : ref.id === factId,
        ) ?? [];
    const [expanded, setExpanded] = useState(false);
    const [dirty, setDirty] = useState(false);
    if (!problems.length && !duplicates.length && !shares.length) return null;
    function resolved(key: string) {
        setHidden((current) => new Set(current).add(key));
        onChanged();
    }
    return (
        <details
            className="mt-2 space-y-2"
            onToggle={(event) => {
                const open = event.currentTarget.open;
                setExpanded(open);
                if (!open && dirty) {
                    setDirty(false);
                    onChanged();
                }
            }}
        >
            <summary className="cursor-pointer text-xs font-medium text-amber-700 dark:text-amber-300">
                {i18n(
                    "{count, plural, one {# open problem} other {# open problems}}",
                    {
                        count:
                            problems.length + duplicates.length + shares.length,
                    },
                )}
            </summary>
            {expanded &&
                shares.map((ref) => (
                    <FolderShareFix
                        key={ref.eventId}
                        eventId={ref.eventId}
                        onChanged={() => setDirty(true)}
                    />
                ))}
            {problems.map((problem) => (
                <CareProblemCard
                    key={problem.key}
                    problem={problem}
                    onResolved={() => resolved(problem.key)}
                />
            ))}
            {duplicates.map((candidate) => (
                <DuplicateFixCard
                    key={candidate.key}
                    candidate={candidate}
                    onResolved={() => resolved(candidate.key)}
                />
            ))}
        </details>
    );
}
