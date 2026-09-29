"use client";

import { Check, Merge, Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { parseApiError } from "@/lib/api-errors";
import type { OwnType } from "@/lib/knowledge/vocabulary";

const MAX_LABEL_LENGTH = 80;

interface MergeTarget {
    kind: "entity" | "relation";
    key: string;
    label: string;
    core: boolean;
}

interface VocabularyListProps {
    types: OwnType[];
    /** The viewer's own types and the core's, each kind merging into its own. */
    targets: MergeTarget[];
    entityTypeLabels: Record<string, string>;
    organization: boolean;
}

type Action = "rename" | "merge" | "delete";

function typeUrl(type: OwnType): string {
    return `/api/knowledge/types/${type.kind}/${encodeURIComponent(type.key)}`;
}

/**
 * The viewer's own types, each with keep (for one a share adopted),
 * rename, merge into another of its kind, and delete. Merging and deleting
 * say how much of the viewer's own knowledge they change, and send that
 * count back so a change meanwhile is refused rather than done unseen.
 */
export function VocabularyList({
    types,
    targets,
    entityTypeLabels,
    organization,
}: VocabularyListProps) {
    const i18n = useExtracted();
    const router = useRouter();
    const [open, setOpen] = useState<{ type: OwnType; action: Action } | null>(
        null,
    );
    const [label, setLabel] = useState("");
    const [targetKey, setTargetKey] = useState("");
    const [mergeCount, setMergeCount] = useState<number | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        setMergeCount(null);
        if (open?.action !== "merge" || !targetKey) return;
        let cancelled = false;
        void fetch(
            `${typeUrl(open.type)}?mergeInto=${encodeURIComponent(targetKey)}`,
        )
            .then((response) => (response.ok ? response.json() : null))
            .then((body: { count?: number } | null) => {
                if (!cancelled) setMergeCount(body?.count ?? null);
            })
            .catch(() => {
                if (!cancelled) setMergeCount(null);
            });
        return () => {
            cancelled = true;
        };
    }, [open, targetKey]);

    const typeName = (key: string) =>
        key === "person" ? i18n("person") : (entityTypeLabels[key] ?? key);

    function shapeOf(type: OwnType): string | null {
        if (type.kind !== "relation") return null;
        const subject = type.shape.subjectTypes.map(typeName).join(", ");
        const object =
            type.shape.objectKind === "literal"
                ? i18n("text")
                : type.shape.objectTypes.map(typeName).join(", ");
        return `${subject} → ${object}`;
    }

    async function send(
        type: OwnType,
        init: { method: string; body: unknown },
        failure: string,
    ): Promise<boolean> {
        setSaving(true);
        try {
            const response = await fetch(typeUrl(type), {
                method: init.method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(init.body),
            });
            if (!response.ok) {
                const body = await parseApiError(response);
                const count = body.details?.count;
                if (response.status === 409 && typeof count === "number") {
                    // What it changes changed meanwhile: show the new
                    // count, for the person to confirm again.
                    if (init.method === "POST") setMergeCount(count);
                    toast.error(
                        i18n(
                            "This changed meanwhile. Check the new count and confirm again.",
                        ),
                    );
                    router.refresh();
                } else {
                    toast.error(body.error || failure);
                }
                return false;
            }
            setOpen(null);
            router.refresh();
            return true;
        } finally {
            setSaving(false);
        }
    }

    if (types.length === 0) {
        return (
            <p className="text-sm text-muted-foreground">
                {i18n("No types of your own yet.")}
            </p>
        );
    }

    // As the page now has it: a refresh after a refused change brings the
    // new count.
    const current = open
        ? (types.find(
              (type) =>
                  type.kind === open.type.kind && type.key === open.type.key,
          ) ?? open.type)
        : undefined;
    const candidates = current
        ? targets.filter(
              (target) =>
                  target.kind === current.kind && target.key !== current.key,
          )
        : [];
    const target = candidates.find((candidate) => candidate.key === targetKey);

    return (
        <>
            <ul className="divide-y rounded-lg border">
                {types.map((type) => (
                    <li
                        key={`${type.kind}:${type.key}`}
                        className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm"
                    >
                        <div className="min-w-0 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">
                                    {type.label}
                                </span>
                                {type.adoptedFromShare && (
                                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
                                        {i18n("From a share")}
                                    </span>
                                )}
                            </div>
                            <div className="text-xs text-muted-foreground">
                                {type.kind === "entity"
                                    ? i18n(
                                          "Kind of thing · {count, plural, one {# entity} other {# entities}}",
                                          { count: type.uses },
                                      )
                                    : i18n(
                                          "Relation {shape} · {count, plural, one {# fact} other {# facts}}",
                                          {
                                              shape: shapeOf(type) ?? "",
                                              count: type.uses,
                                          },
                                      )}
                            </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                            {type.adoptedFromShare && (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={saving}
                                    onClick={() =>
                                        void send(
                                            type,
                                            {
                                                method: "PATCH",
                                                body: { keep: true },
                                            },
                                            i18n("Could not keep this type"),
                                        )
                                    }
                                >
                                    <Check className="mr-2 size-4" />
                                    {i18n("Keep")}
                                </Button>
                            )}
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                    setLabel(type.label);
                                    setOpen({ type, action: "rename" });
                                }}
                            >
                                <Pencil className="mr-2 size-4" />
                                {i18n("Rename")}
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                    setTargetKey("");
                                    setOpen({ type, action: "merge" });
                                }}
                            >
                                <Merge className="mr-2 size-4" />
                                {i18n("Merge into…")}
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                aria-label={i18n("Delete {label}", {
                                    label: type.label,
                                })}
                                onClick={() =>
                                    setOpen({ type, action: "delete" })
                                }
                            >
                                <Trash2 className="size-4" />
                            </Button>
                        </div>
                    </li>
                ))}
            </ul>

            <Dialog
                open={open?.action === "rename"}
                onOpenChange={(value) => !value && setOpen(null)}
            >
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{i18n("Rename type")}</DialogTitle>
                        <DialogDescription>
                            {organization
                                ? i18n(
                                      "The new name shows wherever the Organization's knowledge uses it.",
                                  )
                                : i18n(
                                      "The new name shows wherever your knowledge uses it.",
                                  )}
                        </DialogDescription>
                    </DialogHeader>
                    <Input
                        value={label}
                        onChange={(event) => setLabel(event.target.value)}
                        maxLength={MAX_LABEL_LENGTH}
                        aria-label={i18n("Name")}
                    />
                    <DialogFooter>
                        <Button
                            variant="outline"
                            disabled={saving}
                            onClick={() => setOpen(null)}
                        >
                            {i18n("Cancel")}
                        </Button>
                        <Button
                            disabled={saving || !label.trim() || !current}
                            onClick={() =>
                                current &&
                                void send(
                                    current,
                                    { method: "PATCH", body: { label } },
                                    i18n("Could not rename this type"),
                                )
                            }
                        >
                            {i18n("Save")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog
                open={open?.action === "merge"}
                onOpenChange={(value) => !value && setOpen(null)}
            >
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>
                            {i18n("Merge {name} into…", {
                                name: current?.label ?? "",
                            })}
                        </DialogTitle>
                        <DialogDescription>
                            {organization
                                ? i18n(
                                      "Everything that uses {name}, the members' knowledge included, will use the type you choose, and {name} goes.",
                                      { name: current?.label ?? "" },
                                  )
                                : i18n(
                                      "Everything that uses {name} will use the type you choose, and {name} goes.",
                                      { name: current?.label ?? "" },
                                  )}
                        </DialogDescription>
                    </DialogHeader>
                    <select
                        value={targetKey}
                        onChange={(event) => setTargetKey(event.target.value)}
                        aria-label={i18n("Merge target")}
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <option value="">{i18n("Choose a type")}</option>
                        {candidates.map((candidate) => (
                            <option key={candidate.key} value={candidate.key}>
                                {candidate.label}
                                {candidate.core ? ` · ${i18n("built in")}` : ""}
                            </option>
                        ))}
                    </select>
                    {target && mergeCount !== null && (
                        <p className="text-sm">
                            {current?.kind === "entity"
                                ? i18n(
                                      "{count, plural, =0 {Nothing joins another entity.} one {# entity joins one of {into} with the same name.} other {# entities join ones of {into} with the same name.}}",
                                      {
                                          count: mergeCount,
                                          into: target.label,
                                      },
                                  )
                                : i18n(
                                      "{count, plural, =0 {{into} takes every fact.} one {# fact {into} does not take will be deleted.} other {# facts {into} does not take will be deleted.}}",
                                      {
                                          count: mergeCount,
                                          into: target.label,
                                      },
                                  )}
                        </p>
                    )}
                    <DialogFooter>
                        <Button
                            variant="outline"
                            disabled={saving}
                            onClick={() => setOpen(null)}
                        >
                            {i18n("Cancel")}
                        </Button>
                        <Button
                            disabled={
                                saving ||
                                !target ||
                                mergeCount === null ||
                                !current
                            }
                            onClick={() =>
                                current &&
                                void send(
                                    current,
                                    {
                                        method: "POST",
                                        body: {
                                            mergeInto: targetKey,
                                            confirmCount: mergeCount,
                                        },
                                    },
                                    i18n("Could not merge these types"),
                                )
                            }
                        >
                            {i18n("Merge")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog
                open={open?.action === "delete"}
                onOpenChange={(value) => !value && setOpen(null)}
            >
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>
                            {i18n("Delete {label}?", {
                                label: current?.label ?? "",
                            })}
                        </DialogTitle>
                        <DialogDescription>
                            {current?.kind === "entity"
                                ? i18n(
                                      "{count, plural, =0 {Nothing uses it.} one {# entity of this kind will be deleted, with everything known about it.} other {# entities of this kind will be deleted, with everything known about them.}}",
                                      { count: current?.uses ?? 0 },
                                  )
                                : i18n(
                                      "{count, plural, =0 {No fact uses it.} one {# fact stated with it will be deleted.} other {# facts stated with it will be deleted.}}",
                                      { count: current?.uses ?? 0 },
                                  )}{" "}
                            {organization &&
                                (current?.kind === "entity"
                                    ? i18n(
                                          "Members' own entities of this kind go too.",
                                      )
                                    : i18n(
                                          "Members get back their own type where theirs was adopted as this one; their other facts with it go.",
                                      ))}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            disabled={saving}
                            onClick={() => setOpen(null)}
                        >
                            {i18n("Cancel")}
                        </Button>
                        <Button
                            variant="destructive"
                            disabled={saving || !current}
                            onClick={() =>
                                current &&
                                void send(
                                    current,
                                    {
                                        method: "DELETE",
                                        body: { confirmCount: current.uses },
                                    },
                                    i18n("Could not delete this type"),
                                )
                            }
                        >
                            {i18n("Delete")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
