"use client";

import { useExtracted } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CareProblemList } from "@/components/almanac/care-problem-list";
import { DuplicateFixCard } from "@/components/almanac/duplicate-fix-card";
import { ShareAdditionsList } from "@/components/almanac/share-additions-list";
import { Button } from "@/components/ui/button";
import { getApiErrorMessage } from "@/lib/api-errors";
import type { CareProblemKind } from "@/lib/knowledge/care-types";
import { MAX_DUPLICATE_RECORDS } from "@/lib/knowledge/duplicate-limits";
import type { DuplicateKind } from "@/lib/knowledge/duplicate-score";
import type {
    DuplicateCandidate,
    DuplicatePage,
} from "@/lib/knowledge/duplicates";

/** Extensible curator queue: problem types on the left and actionable evidence cards on the right. */
export function CareQueue({
    initial,
    sessionKey,
}: {
    initial?: DuplicatePage;
    sessionKey: string;
}) {
    const i18n = useExtracted();
    const [section, setSection] = useState<
        "duplicates" | "shares" | CareProblemKind
    >("duplicates");
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
        const next = new Set(hidden).add(candidate.key);
        setHidden(next);
        try {
            sessionStorage.setItem(storageKey, JSON.stringify([...next]));
        } catch {}
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
        {
            id: "shares",
            label: i18n("New from sharing"),
            hint: i18n("Last 14 days"),
        },
        {
            id: "fact_conflict",
            label: i18n("Conflicting facts"),
            hint: i18n("Two current values for one relation"),
        },
        {
            id: "correction_conflict",
            label: i18n("Corrections pointing two ways"),
            hint: i18n("One heard-as form, different targets"),
        },
        {
            id: "thin",
            label: i18n("Thin records"),
            hint: i18n("One mention, no facts, unused for 120 days"),
        },
    ] as const;
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
                        aria-pressed={section === kind.id}
                        onClick={() => setSection(kind.id)}
                        className="w-full rounded-md px-3 py-2 text-left text-sm font-medium aria-pressed:bg-primary/5"
                    >
                        {kind.label}
                        <small className="block font-normal text-muted-foreground">
                            {kind.hint}
                        </small>
                    </button>
                ))}
            </nav>
            <div className="min-w-0 space-y-3 p-4" aria-live="polite">
                {section === "shares" ? (
                    <ShareAdditionsList />
                ) : section !== "duplicates" ? (
                    <CareProblemList key={section} kind={section} />
                ) : (
                    <>
                        <fieldset
                            className="flex gap-2"
                            aria-label={i18n("Duplicate kind")}
                        >
                            <Button
                                size="sm"
                                variant={
                                    kind === "person" ? "default" : "outline"
                                }
                                aria-pressed={kind === "person"}
                                onClick={() => setKind("person")}
                            >
                                {i18n("People")}
                            </Button>
                            <Button
                                size="sm"
                                variant={
                                    kind === "entity" ? "default" : "outline"
                                }
                                aria-pressed={kind === "entity"}
                                onClick={() => setKind("entity")}
                            >
                                {i18n("Things")}
                            </Button>
                        </fieldset>
                        {initialLoading && <output>{i18n("Loading…")}</output>}
                        {loadError && (
                            <p role="alert">
                                {i18n("Could not load duplicates")}
                            </p>
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
                            <DuplicateFixCard
                                key={candidate.key}
                                candidate={candidate}
                                onResolved={(mergedIds) =>
                                    setPage((current) => ({
                                        ...current,
                                        candidates: current.candidates.filter(
                                            (pair) =>
                                                pair.key !== candidate.key &&
                                                !mergedIds?.includes(
                                                    pair.left.id,
                                                ) &&
                                                !mergedIds?.includes(
                                                    pair.right.id,
                                                ),
                                        ),
                                    }))
                                }
                                onLater={() => later(candidate)}
                            />
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
                    </>
                )}
            </div>
        </div>
    );
}
