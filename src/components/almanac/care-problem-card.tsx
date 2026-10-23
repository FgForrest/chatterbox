"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useExtracted, useFormatter } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { CareProblem } from "@/lib/knowledge/care-types";
import { useVocabularyLabels } from "@/lib/knowledge/vocabulary-labels";

/** Shared problem evidence and fixes, used in Care and in a folder. */
export function CareProblemCard({
    problem,
    onResolved,
}: {
    problem: CareProblem;
    onResolved: () => void;
}) {
    const i18n = useExtracted();
    const formatter = useFormatter();
    const vocabulary = useVocabularyLabels();
    const router = useRouter();
    const [hidden, setHidden] = useState(false);
    async function fix(
        action: "dismiss" | "keep" | "delete",
        optionId?: string,
    ) {
        setHidden(true);
        try {
            const response = await fetch("/api/knowledge/care", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ key: problem.key, action, optionId }),
            });
            if (!response.ok) throw new Error();
            onResolved();
            router.refresh();
        } catch {
            setHidden(false);
            toast.error(
                i18n("Could not fix this problem. Reload and try again."),
            );
        }
    }
    if (hidden) return null;
    return (
        <article className="space-y-3 rounded-lg border bg-card p-4">
            <h3 className="text-sm font-semibold">
                {problem.kind === "fact_conflict"
                    ? i18n("Conflicting facts")
                    : problem.kind === "correction_conflict"
                      ? i18n("Corrections pointing two ways")
                      : i18n("Thin record")}
            </h3>
            <div className="flex flex-wrap gap-2">
                {problem.records.map((record) => (
                    <Link
                        key={record.id}
                        href={
                            record.kind === "person"
                                ? `/almanac/${record.id}`
                                : `/almanac/things/${record.id}`
                        }
                        className="text-sm font-medium hover:underline"
                    >
                        {record.name}
                    </Link>
                ))}
            </div>
            {problem.relationKey && (
                <p className="text-sm">
                    {vocabulary.relation(
                        problem.relationKey,
                        problem.relationLabel,
                    )}
                </p>
            )}
            {problem.heard && (
                <p className="text-sm">
                    {i18n("Heard as: {form}", { form: problem.heard })}
                </p>
            )}
            {problem.lastAt && (
                <p className="text-xs text-muted-foreground">
                    {i18n("One mention, no facts. Last used {date}.", {
                        date: formatter.dateTime(new Date(problem.lastAt), {
                            dateStyle: "medium",
                        }),
                    })}
                </p>
            )}
            <div className="flex flex-wrap gap-2">
                {problem.options.map((option) => (
                    <Button
                        key={option.id}
                        size="sm"
                        variant="outline"
                        onClick={() => void fix("keep", option.id)}
                    >
                        {i18n("Keep {value}", { value: option.label })}
                    </Button>
                ))}
                {problem.kind === "thin" && (
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void fix("delete")}
                    >
                        {i18n("Delete")}
                    </Button>
                )}
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void fix("dismiss")}
                >
                    {problem.kind === "thin" ? i18n("Keep") : i18n("Dismiss")}
                </Button>
            </div>
        </article>
    );
}
