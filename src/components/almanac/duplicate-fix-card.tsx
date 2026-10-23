"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { CompareJoinDialog } from "@/components/almanac/compare-join-dialog";
import { DuplicateSignals } from "@/components/almanac/duplicate-signals";
import { Button } from "@/components/ui/button";
import type { DuplicateCandidate } from "@/lib/knowledge/duplicates";
import { useVocabularyLabels } from "@/lib/knowledge/vocabulary-labels";

/** The same duplicate evidence and fixes in Care and folder knowledge. */
export function DuplicateFixCard({
    candidate,
    onResolved,
    onLater,
}: {
    candidate: DuplicateCandidate;
    onResolved: (mergedIds?: string[]) => void;
    onLater?: () => void;
}) {
    const i18n = useExtracted();
    const labels = useVocabularyLabels();
    const router = useRouter();
    const [hidden, setHidden] = useState(false);
    const [comparing, setComparing] = useState(false);
    async function dismiss() {
        setHidden(true);
        try {
            const response = await fetch("/api/knowledge/duplicates", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    kind: candidate.left.kind,
                    left: candidate.left.id,
                    right: candidate.right.id,
                }),
            });
            if (!response.ok) throw new Error();
            toast.success(i18n("This pair will not be suggested again."));
            onResolved();
            router.refresh();
        } catch {
            setHidden(false);
            toast.error(i18n("Could not dismiss this pair"));
        }
    }
    if (hidden) return null;
    return (
        <>
            <article className="space-y-3 rounded-lg border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold">
                        {candidate.left.kind === "person"
                            ? i18n("Possibly the same person")
                            : i18n("Possibly the same thing")}
                    </h2>
                    <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${candidate.confidence === "high" ? "bg-emerald-600/10 text-emerald-700 dark:text-emerald-300" : candidate.confidence === "medium" ? "bg-amber-600/10 text-amber-800 dark:text-amber-300" : "bg-muted text-muted-foreground"}`}
                    >
                        {candidate.confidence === "high"
                            ? i18n("High match")
                            : candidate.confidence === "medium"
                              ? i18n("Medium match")
                              : i18n("Probably not")}
                    </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr]">
                    {[candidate.left, candidate.right].map((record, index) => (
                        <div key={record.id} className="contents">
                            {index === 1 && (
                                <span
                                    aria-hidden="true"
                                    className="hidden self-center text-muted-foreground sm:block"
                                >
                                    ≈
                                </span>
                            )}
                            <div className="min-w-0 space-y-1 rounded-lg border p-3 text-sm">
                                <Link
                                    className="font-semibold hover:underline"
                                    href={
                                        record.kind === "person"
                                            ? `/almanac/${record.id}`
                                            : `/almanac/things/${record.id}`
                                    }
                                >
                                    {record.name}
                                </Link>
                                <span className="ml-2 inline-flex rounded-full bg-organization/10 px-2 text-xs text-organization">
                                    {i18n("Organization")}
                                </span>
                                <p className="break-all text-muted-foreground">
                                    {record.kind === "person"
                                        ? (record.primaryEmail ??
                                          i18n("No email"))
                                        : labels.entityType(
                                              record.typeKey,
                                              record.typeLabel,
                                          )}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {i18n(
                                        "{count, plural, one {# piece of evidence} other {# pieces of evidence}}",
                                        {
                                            count: record.evidenceCount,
                                        },
                                    )}
                                </p>
                            </div>
                        </div>
                    ))}
                </div>
                <DuplicateSignals
                    for={candidate.for}
                    against={candidate.against}
                />
                <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => setComparing(true)}>
                        {i18n("Merge…")}
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void dismiss()}
                    >
                        {i18n("Not the same")}
                    </Button>
                    {onLater && (
                        <Button
                            size="sm"
                            variant="ghost"
                            className="ml-auto"
                            onClick={onLater}
                        >
                            {i18n("Later")}
                        </Button>
                    )}
                </div>
            </article>
            <CompareJoinDialog
                candidate={comparing ? candidate : null}
                onClose={() => setComparing(false)}
                onMerged={() => {
                    setComparing(false);
                    setHidden(true);
                    onResolved([candidate.left.id, candidate.right.id]);
                    router.refresh();
                }}
            />
        </>
    );
}
