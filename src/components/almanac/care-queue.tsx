"use client";

import Link from "next/link";
import { useExtracted } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CompareJoinDialog } from "@/components/almanac/compare-join-dialog";
import { DuplicateSignals } from "@/components/almanac/duplicate-signals";
import { Button } from "@/components/ui/button";
import { getApiErrorMessage } from "@/lib/api-errors";
import { MAX_DUPLICATE_RECORDS } from "@/lib/knowledge/duplicate-limits";
import type { DuplicateKind } from "@/lib/knowledge/duplicate-score";
import type {
    DuplicateCandidate,
    DuplicatePage,
} from "@/lib/knowledge/duplicates";
import { useVocabularyLabels } from "@/lib/knowledge/vocabulary-labels";

/** Extensible curator queue: problem types on the left and actionable evidence cards on the right. */
export function CareQueue({
    initial,
    sessionKey,
}: {
    initial?: DuplicatePage;
    sessionKey: string;
}) {
    const i18n = useExtracted();
    const labels = useVocabularyLabels();
    const [page, setPage] = useState<DuplicatePage>(
        initial ?? { candidates: [], nextCursor: null, limited: false },
    );
    const [kind, setKind] = useState<DuplicateKind>(
        initial?.candidates[0]?.left.kind ?? "person",
    );
    const [initialLoading, setInitialLoading] = useState(!initial);
    const [loadError, setLoadError] = useState(false);
    const requestVersion = useRef(0);
    const [hidden, setHidden] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(false);
    const pendingDismissals = useRef(new Set<string>());
    const firstKind = useRef(initial ? kind : null);
    useEffect(() => {
        const version = ++requestVersion.current;
        setLoading(false);
        if (firstKind.current === kind) {
            firstKind.current = null;
            return;
        }
        const controller = new AbortController();
        setPage({ candidates: [], nextCursor: null, limited: false });
        setInitialLoading(true);
        setLoadError(false);
        void fetch(`/api/knowledge/duplicates?kind=${kind}`, {
            signal: controller.signal,
        })
            .then(async (response) => {
                if (!response.ok) throw new Error();
                const data: DuplicatePage = await response.json();
                if (
                    controller.signal.aborted ||
                    requestVersion.current !== version
                )
                    return;
                setPage(data);
            })
            .catch(() => {
                if (!controller.signal.aborted) setLoadError(true);
            })
            .finally(() => {
                if (!controller.signal.aborted) setInitialLoading(false);
            });
        return () => controller.abort();
    }, [kind]);
    const [comparing, setComparing] = useState<DuplicateCandidate | null>(null);
    const storageKey = `almanac-care-later:${sessionKey}`;
    useEffect(() => {
        try {
            const stored: unknown = JSON.parse(
                sessionStorage.getItem(storageKey) ?? "[]",
            );
            if (Array.isArray(stored))
                setHidden(
                    new Set(
                        stored.filter(
                            (key): key is string => typeof key === "string",
                        ),
                    ),
                );
        } catch {}
    }, [storageKey]);

    function later(candidate: DuplicateCandidate) {
        if (pendingDismissals.current.has(candidate.key)) return;
        const next = new Set(hidden).add(candidate.key);
        setHidden(next);
        try {
            sessionStorage.setItem(
                storageKey,
                JSON.stringify(
                    [...next].filter(
                        (key) => !pendingDismissals.current.has(key),
                    ),
                ),
            );
        } catch {}
    }

    async function dismiss(candidate: DuplicateCandidate) {
        pendingDismissals.current.add(candidate.key);
        setHidden((current) => new Set(current).add(candidate.key));
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
            if (!response.ok)
                throw new Error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not dismiss this pair"),
                    ),
                );
            toast.success(i18n("This pair will not be suggested again."));
        } catch (error) {
            setHidden((current) => {
                const next = new Set(current);
                next.delete(candidate.key);
                return next;
            });
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Could not dismiss this pair"),
            );
        } finally {
            pendingDismissals.current.delete(candidate.key);
        }
    }

    async function more() {
        if (!page.nextCursor || loading) return;
        setLoading(true);
        const version = requestVersion.current;
        try {
            const response = await fetch(
                `/api/knowledge/duplicates?kind=${kind}&cursor=${encodeURIComponent(page.nextCursor)}`,
            );
            if (!response.ok)
                throw new Error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not load duplicates"),
                    ),
                );
            const next: DuplicatePage = await response.json();
            if (version !== requestVersion.current) return;
            setPage((current) => ({
                ...next,
                candidates: [
                    ...current.candidates,
                    ...next.candidates.filter(
                        (candidate) =>
                            !current.candidates.some(
                                (existing) => existing.key === candidate.key,
                            ),
                    ),
                ],
            }));
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Could not load duplicates"),
            );
        } finally {
            if (version === requestVersion.current) setLoading(false);
        }
    }
    const kinds = [
        {
            id: "duplicates",
            label: i18n("Possible duplicates"),
            hint: i18n("The same person or thing twice"),
        },
    ];
    const cards = page.candidates.filter(
        (candidate) => !hidden.has(candidate.key),
    );
    return (
        <div className="grid min-h-[520px] overflow-hidden rounded-xl border md:grid-cols-[230px_minmax(0,1fr)]">
            <nav
                aria-label={i18n("Problem types")}
                className="border-b bg-card p-2 md:border-r md:border-b-0"
            >
                {kinds.map((kind) => (
                    <button
                        key={kind.id}
                        type="button"
                        aria-pressed="true"
                        className="w-full rounded-md bg-primary/5 px-3 py-2 text-left text-sm font-medium"
                    >
                        {kind.label}
                        <small className="block font-normal text-muted-foreground">
                            {kind.hint}
                        </small>
                    </button>
                ))}
            </nav>
            <div className="min-w-0 space-y-3 p-4" aria-live="polite">
                <fieldset
                    className="flex gap-2"
                    aria-label={i18n("Duplicate kind")}
                >
                    <Button
                        size="sm"
                        variant={kind === "person" ? "default" : "outline"}
                        aria-pressed={kind === "person"}
                        onClick={() => setKind("person")}
                    >
                        {i18n("People")}
                    </Button>
                    <Button
                        size="sm"
                        variant={kind === "entity" ? "default" : "outline"}
                        aria-pressed={kind === "entity"}
                        onClick={() => setKind("entity")}
                    >
                        {i18n("Things")}
                    </Button>
                </fieldset>
                {initialLoading && <output>{i18n("Loading…")}</output>}
                {loadError && (
                    <p role="alert">{i18n("Could not load duplicates")}</p>
                )}
                {page.limited && (
                    <p className="text-sm text-muted-foreground">
                        {i18n(
                            "This scan checks the newest {limit, number} records of each kind and their closest matches. Duplicates involving older records outside this limit are not suggested.",
                            { limit: MAX_DUPLICATE_RECORDS },
                        )}
                    </p>
                )}
                {!initialLoading && !loadError && !cards.length && (
                    <p className="py-10 text-center text-sm text-muted-foreground">
                        {i18n("All done here.")}
                    </p>
                )}
                {cards.map((candidate) => (
                    <article
                        key={candidate.key}
                        className="space-y-3 rounded-lg border bg-card p-4"
                    >
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
                            {[candidate.left, candidate.right].map(
                                (record, index) => (
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
                                ),
                            )}
                        </div>
                        <DuplicateSignals
                            for={candidate.for}
                            against={candidate.against}
                        />
                        <div className="flex flex-wrap gap-2">
                            <Button
                                size="sm"
                                onClick={() => setComparing(candidate)}
                            >
                                {i18n("Merge…")}
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void dismiss(candidate)}
                            >
                                {i18n("Not the same")}
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                className="ml-auto"
                                onClick={() => later(candidate)}
                            >
                                {i18n("Later")}
                            </Button>
                        </div>
                    </article>
                ))}
                {page.nextCursor && (
                    <Button
                        variant="outline"
                        disabled={loading}
                        onClick={() => void more()}
                    >
                        {loading ? i18n("Loading…") : i18n("Load more")}
                    </Button>
                )}
                <CompareJoinDialog
                    candidate={comparing}
                    onClose={() => setComparing(null)}
                    onMerged={(ids) => {
                        setPage((current) => ({
                            ...current,
                            candidates: current.candidates.filter(
                                (candidate) =>
                                    !ids.includes(candidate.left.id) &&
                                    !ids.includes(candidate.right.id),
                            ),
                        }));
                        setComparing(null);
                    }}
                />
            </div>
        </div>
    );
}
