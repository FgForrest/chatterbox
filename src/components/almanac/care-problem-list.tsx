"use client";

import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { CareProblemCard } from "@/components/almanac/care-problem-card";
import { Button } from "@/components/ui/button";
import type {
    CareProblemKind,
    CareProblemPage,
} from "@/lib/knowledge/care-types";

export function CareProblemList({ kind }: { kind: CareProblemKind }) {
    const i18n = useExtracted();
    const [data, setData] = useState<CareProblemPage | null>(null);
    const [offset, setOffset] = useState(0);
    const [error, setError] = useState(false);
    const [retry, setRetry] = useState(0);
    useEffect(() => {
        const controller = new AbortController();
        setError(false);
        void fetch(
            `/api/knowledge/care?kind=${kind}&offset=${offset}&retry=${retry}`,
            {
                signal: controller.signal,
            },
        )
            .then(async (response) => {
                if (!response.ok) throw new Error();
                const page: CareProblemPage = await response.json();
                if (!controller.signal.aborted) setData(page);
            })
            .catch(() => {
                if (!controller.signal.aborted) setError(true);
            });
        return () => controller.abort();
    }, [kind, offset, retry]);
    return (
        <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
                {i18n(
                    "The scan checks up to 2,000 newest records of each kind, 32,000 current facts and 16,000 heard-as forms. Older problems outside these limits may not appear.",
                )}
            </p>
            {error ? (
                <div role="alert">
                    {i18n("Could not load Care")}{" "}
                    <Button
                        variant="outline"
                        onClick={() => setRetry((value) => value + 1)}
                    >
                        {i18n("Try again")}
                    </Button>
                </div>
            ) : !data ? (
                <output>{i18n("Loading…")}</output>
            ) : (
                <>
                    {!data.problems.length && <p>{i18n("All done here.")}</p>}
                    {data.problems.map((problem) => (
                        <CareProblemCard
                            key={problem.key}
                            problem={problem}
                            onResolved={() =>
                                setData((current) =>
                                    current
                                        ? {
                                              ...current,
                                              problems: current.problems.filter(
                                                  (row) =>
                                                      row.key !== problem.key,
                                              ),
                                          }
                                        : null,
                                )
                            }
                        />
                    ))}
                    <div className="flex gap-2">
                        {offset > 0 && (
                            <Button
                                variant="outline"
                                onClick={() =>
                                    setOffset((value) =>
                                        Math.max(0, value - 20),
                                    )
                                }
                            >
                                {i18n("Previous")}
                            </Button>
                        )}
                        {data.nextOffset !== null && (
                            <Button
                                variant="outline"
                                onClick={() => setOffset(data.nextOffset ?? 0)}
                            >
                                {i18n("Next")}
                            </Button>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
