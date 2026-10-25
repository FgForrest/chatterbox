"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useExtracted, useFormatter } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import type {
    KeptReason,
    ShareAddition,
    SharedAdditionsGroup,
    SharedAdditionsPage,
    ShareUndoResult,
} from "@/lib/knowledge/share-review";

export function ShareAdditionsGroupCard({
    group,
    onChanged,
}: {
    group: SharedAdditionsGroup;
    onChanged: () => void;
}) {
    const i18n = useExtracted();
    const formatter = useFormatter();
    const router = useRouter();
    const confirm = useConfirm();
    const [data, setData] = useState(group);
    const [busy, setBusy] = useState(false);
    const [reviewed, setReviewed] = useState(Boolean(group.reviewedAt));
    const [result, setResult] = useState<ShareUndoResult | null>(null);
    const reason = (value: KeptReason) =>
        value === "changed"
            ? i18n("Kept: edited or confirmed since sharing")
            : value === "merged"
              ? i18n("Kept: involved in a merge")
              : value === "later_share"
                ? i18n("Kept: used by a later share")
                : value === "other_source"
                  ? i18n("Kept: other knowledge depends on it")
                  : i18n("No longer present in the Organization Almanac");
    const kind = (addition: ShareAddition) =>
        addition.kind === "person"
            ? i18n("Person")
            : addition.kind === "entity"
              ? i18n("Thing")
              : addition.kind === "fact"
                ? i18n("Fact")
                : addition.kind === "correction"
                  ? i18n("Correction")
                  : addition.kind === "alias"
                    ? i18n("Alias")
                    : i18n("E-mail");
    async function act(
        action: "review" | "undo" | "delete",
        additionId?: string,
    ) {
        if (busy) return;
        setBusy(true);
        const previous = data;
        if (action === "review") setReviewed(true);
        else
            setData((current) => ({
                ...current,
                additions: current.additions.map((row) =>
                    !additionId || row.id === additionId
                        ? { ...row, removedAt: new Date().toISOString() }
                        : row,
                ),
            }));
        try {
            const response = await fetch("/api/knowledge/care/shares", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ eventId: group.id, action, additionId }),
            });
            if (!response.ok) throw new Error();
            if (action !== "review") {
                const outcome: ShareUndoResult = await response.json();
                setResult(outcome);
                setData((current) => ({
                    ...current,
                    undoneAt:
                        action === "undo"
                            ? new Date().toISOString()
                            : current.undoneAt,
                    additions: previous.additions.map((row) =>
                        outcome.removed.includes(row.id)
                            ? { ...row, removedAt: new Date().toISOString() }
                            : outcome.kept.some((kept) => kept.id === row.id)
                              ? {
                                    ...row,
                                    keptReason:
                                        outcome.kept.find(
                                            (kept) => kept.id === row.id,
                                        )?.reason ?? null,
                                }
                              : row,
                    ),
                }));
            }
            onChanged();
            router.refresh();
        } catch {
            setData(previous);
            if (action === "review") setReviewed(Boolean(previous.reviewedAt));
            toast.error(i18n("Could not update this share's additions"));
        } finally {
            setBusy(false);
        }
    }
    async function remove(additionId?: string) {
        if (
            await confirm({
                title: additionId
                    ? i18n("Delete this addition?")
                    : i18n("Undo all additions from this share?"),
                description: additionId
                    ? i18n(
                          "It is removed from the Organization Almanac unless other knowledge depends on it. This cannot be undone.",
                      )
                    : i18n(
                          "Untouched additions are removed from the Organization Almanac. The item stays shared. This cannot be undone.",
                      ),
                confirmLabel: additionId
                    ? i18n("Delete addition")
                    : i18n("Undo additions"),
                destructive: true,
                onConfirm: () => {},
            })
        )
            await act(additionId ? "delete" : "undo", additionId);
    }
    async function more() {
        if (data.nextOffset === null || busy) return;
        setBusy(true);
        try {
            const response = await fetch(
                `/api/knowledge/care/shares?eventId=${encodeURIComponent(group.id)}&additionOffset=${data.nextOffset}`,
            );
            if (!response.ok) throw new Error();
            const next: SharedAdditionsPage = await response.json();
            const page = next.groups[0];
            if (page)
                setData((current) => ({
                    ...page,
                    additions: [...current.additions, ...page.additions],
                }));
        } catch {
            toast.error(i18n("Could not load Care"));
        } finally {
            setBusy(false);
        }
    }
    return (
        <article className="space-y-3 rounded-lg border bg-card p-4">
            <h3 className="text-sm font-semibold">
                {data.item ? (
                    <Link
                        href={`/dashboard?recording=${encodeURIComponent(data.item.id)}&view=org`}
                        className="hover:underline"
                    >
                        {data.item.title}
                    </Link>
                ) : (
                    i18n("Item no longer shared")
                )}
            </h3>
            <p className="text-xs text-muted-foreground">
                {data.sharer ?? i18n("Member")} ·{" "}
                {formatter.dateTime(new Date(data.createdAt), {
                    dateStyle: "medium",
                    timeStyle: "short",
                })}
            </p>
            <ul className="space-y-2">
                {data.additions.map((addition) => {
                    const href = addition.personId
                        ? `/almanac/${addition.personId}`
                        : addition.entityId
                          ? `/almanac/things/${addition.entityId}`
                          : null;
                    return (
                        <li
                            key={addition.id}
                            className="flex flex-wrap items-center gap-2 text-sm"
                        >
                            <span>
                                {kind(addition)}:{" "}
                                {addition.label ?? i18n("No longer present")}
                            </span>
                            {href && (
                                <Link
                                    href={href}
                                    className="text-primary hover:underline"
                                >
                                    {i18n("Review record")}
                                </Link>
                            )}
                            {addition.removedAt ? (
                                <span className="text-xs text-muted-foreground">
                                    {i18n("Removed")}
                                </span>
                            ) : addition.keptReason ? (
                                <span className="text-xs text-muted-foreground">
                                    {reason(addition.keptReason)}
                                </span>
                            ) : (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={busy || Boolean(data.undoneAt)}
                                    onClick={() => void remove(addition.id)}
                                >
                                    {i18n("Delete addition")}
                                </Button>
                            )}
                        </li>
                    );
                })}
            </ul>
            {data.nextOffset !== null && (
                <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void more()}
                >
                    {i18n("More additions")}
                </Button>
            )}
            {result && (
                <output className="block text-sm">
                    {i18n("Removed {removed, number}; kept {kept, number}.", {
                        removed: result.removed.length,
                        kept: result.kept.length,
                    })}
                </output>
            )}
            <div className="flex flex-wrap gap-2">
                <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || reviewed}
                    onClick={() => void act("review")}
                >
                    {reviewed ? i18n("Reviewed") : i18n("Mark reviewed")}
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || Boolean(data.undoneAt)}
                    onClick={() => void remove()}
                >
                    {i18n("Undo all additions from this share")}
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">
                {i18n(
                    "Undo leaves the item shared. Changed additions and data from other sources are kept.",
                )}
            </p>
        </article>
    );
}

export function ShareAdditionsList() {
    const i18n = useExtracted();
    const [page, setPage] = useState<SharedAdditionsPage | null>(null);
    const [offset, setOffset] = useState(0);
    const [retry, setRetry] = useState(0);
    const [error, setError] = useState(false);
    useEffect(() => {
        const controller = new AbortController();
        setError(false);
        void fetch(
            `/api/knowledge/care/shares?offset=${offset}&retry=${retry}`,
            {
                signal: controller.signal,
            },
        )
            .then(async (response) => {
                if (!response.ok) throw new Error();
                const next: SharedAdditionsPage = await response.json();
                if (!controller.signal.aborted) setPage(next);
            })
            .catch(() => {
                if (!controller.signal.aborted) setError(true);
            });
        return () => controller.abort();
    }, [offset, retry]);
    return (
        <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
                {i18n(
                    "Additions from shares in the last 14 days. Shares made before the upgrade have no provenance and cannot be undone here.",
                )}
            </p>
            {error ? (
                <div role="alert">
                    {i18n("Could not load Care")}
                    <Button
                        variant="outline"
                        onClick={() => setRetry((value) => value + 1)}
                    >
                        {i18n("Try again")}
                    </Button>
                </div>
            ) : !page ? (
                <output>{i18n("Loading…")}</output>
            ) : (
                <>
                    {!page.groups.length && <p>{i18n("All done here.")}</p>}
                    {page.groups.map((group) => (
                        <ShareAdditionsGroupCard
                            key={group.id}
                            group={group}
                            onChanged={() => {}}
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
                        {page.nextOffset !== null && (
                            <Button
                                variant="outline"
                                onClick={() => setOffset(page.nextOffset ?? 0)}
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
