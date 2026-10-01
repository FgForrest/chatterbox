"use client";

import { Merge, NotebookPen, Pencil, Shapes, Trash2 } from "lucide-react";
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
import { getApiErrorMessage, parseApiError } from "@/lib/api-errors";

interface Candidate {
    id: string;
    name: string;
    scope: "personal" | "org";
}

type Editing = "edit" | "type" | "merge" | "erase" | "notes" | null;

/**
 * Change a thing: edit its name and description, give it another type,
 * fold it into another of its type, or erase it. Whoever may not change it
 * (a member, on an Organization thing) keeps private notes on it instead.
 */
export function EntityActions({
    entity,
    canManage,
    types,
    relationLabels = {},
}: {
    entity: {
        id: string;
        name: string;
        typeKey: string;
        description: string | null;
        notes: string | null;
        scope: "personal" | "org";
    };
    canManage: boolean;
    /** The types it may take. */
    types: { key: string; label: string }[];
    /** Relation labels by key, to name a fact that blocks a type change. */
    relationLabels?: Record<string, string>;
}) {
    const i18n = useExtracted();
    const router = useRouter();
    const [editing, setEditing] = useState<Editing>(null);
    const [name, setName] = useState(entity.name);
    const [description, setDescription] = useState(entity.description ?? "");
    const [notes, setNotes] = useState(entity.notes ?? "");
    const [typeKey, setTypeKey] = useState(entity.typeKey);
    const [candidates, setCandidates] = useState<Candidate[]>([]);
    const [targetId, setTargetId] = useState("");
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (editing !== "merge") return;
        let cancelled = false;
        void fetch(
            `/api/knowledge/entities?typeKey=${encodeURIComponent(entity.typeKey)}`,
        )
            .then((response) =>
                response.ok ? response.json() : { entities: [] },
            )
            .then((body: { entities?: Candidate[] }) => {
                if (cancelled) return;
                // An Organization thing folds only into another of the
                // Organization's; a private one into anything its owner sees.
                setCandidates(
                    (body.entities ?? []).filter(
                        (candidate) =>
                            candidate.id !== entity.id &&
                            (entity.scope !== "org" ||
                                candidate.scope === "org"),
                    ),
                );
            })
            .catch(() => {
                if (!cancelled) setCandidates([]);
            });
        return () => {
            cancelled = true;
        };
    }, [editing, entity.id, entity.scope, entity.typeKey]);

    const open = (next: Editing) => {
        setCandidates([]);
        setName(entity.name);
        setDescription(entity.description ?? "");
        setNotes(entity.notes ?? "");
        setTypeKey(entity.typeKey);
        setTargetId("");
        setEditing(next);
    };

    /** Send one change; false when it was refused (and said why). */
    async function send(
        method: "PATCH" | "POST" | "DELETE",
        body: Record<string, unknown> | null,
        fallback: string,
    ): Promise<Response | null> {
        setSaving(true);
        try {
            const response = await fetch(
                `/api/knowledge/entities/${entity.id}`,
                {
                    method,
                    headers: body
                        ? { "Content-Type": "application/json" }
                        : undefined,
                    body: body ? JSON.stringify(body) : undefined,
                },
            );
            if (!response.ok) {
                toast.error(await getApiErrorMessage(response, fallback));
                return null;
            }
            return response;
        } finally {
            setSaving(false);
        }
    }

    async function saveEdit() {
        const changes: Record<string, unknown> = {};
        if (name.trim() !== entity.name) changes.name = name;
        if ((description.trim() || null) !== entity.description) {
            changes.description = description.trim() || null;
        }
        if (
            Object.keys(changes).length === 0 ||
            (await send("PATCH", changes, i18n("Could not save this thing")))
        ) {
            setEditing(null);
            router.refresh();
        }
    }

    async function saveNotes() {
        if (
            await send(
                "PATCH",
                { description: notes.trim() || null },
                i18n("Could not save your notes"),
            )
        ) {
            setEditing(null);
            router.refresh();
        }
    }

    async function saveType() {
        if (typeKey === entity.typeKey) {
            setEditing(null);
            return;
        }
        setSaving(true);
        try {
            const response = await fetch(
                `/api/knowledge/entities/${entity.id}`,
                {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ typeKey }),
                },
            );
            if (!response.ok) {
                const error = await parseApiError(response);
                const relation = error.details?.relationKey;
                toast.error(
                    typeof relation === "string"
                        ? i18n(
                              "A fact “{relation}” about it would no longer fit. Change or erase it first.",
                              {
                                  relation:
                                      relationLabels[relation] ?? relation,
                              },
                          )
                        : error.error || i18n("Could not change the type"),
                );
                return;
            }
            setEditing(null);
            router.refresh();
        } finally {
            setSaving(false);
        }
    }

    async function merge() {
        if (!targetId) return;
        const response = await send(
            "POST",
            { mergeIntoId: targetId },
            i18n("Could not merge these things"),
        );
        if (!response) return;
        const body = (await response.json()) as { entity?: { id: string } };
        router.push(`/almanac/things/${body.entity?.id ?? targetId}`);
        router.refresh();
    }

    async function erase() {
        if (await send("DELETE", null, i18n("Could not erase this thing"))) {
            router.push("/almanac/things");
            router.refresh();
        }
    }

    const footer = (action: () => void, label: string, disabled = false) => (
        <DialogFooter>
            <Button
                variant="outline"
                disabled={saving}
                onClick={() => setEditing(null)}
            >
                {i18n("Cancel")}
            </Button>
            <Button
                variant={editing === "erase" ? "destructive" : "default"}
                disabled={saving || disabled}
                onClick={action}
            >
                {label}
            </Button>
        </DialogFooter>
    );

    if (!canManage) {
        return (
            <>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() => open("notes")}
                >
                    <NotebookPen className="size-4" /> {i18n("Your notes")}
                </Button>
                <Dialog
                    open={editing === "notes"}
                    onOpenChange={(value) => !value && setEditing(null)}
                >
                    <DialogContent className="sm:max-w-md">
                        <DialogHeader>
                            <DialogTitle>{i18n("Your notes")}</DialogTitle>
                            <DialogDescription>
                                {i18n(
                                    "Only you see your notes on an Organization thing.",
                                )}
                            </DialogDescription>
                        </DialogHeader>
                        <textarea
                            value={notes}
                            maxLength={4000}
                            onChange={(event) => setNotes(event.target.value)}
                            aria-label={i18n("Your notes")}
                            className="min-h-28 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                        {footer(() => void saveNotes(), i18n("Save"))}
                    </DialogContent>
                </Dialog>
            </>
        );
    }

    return (
        <>
            <Button size="sm" variant="outline" onClick={() => open("edit")}>
                <Pencil className="size-4" /> {i18n("Edit")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => open("type")}>
                <Shapes className="size-4" /> {i18n("Change type")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => open("merge")}>
                <Merge className="size-4" /> {i18n("Merge into…")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => open("erase")}>
                <Trash2 className="size-4" /> {i18n("Erase")}
            </Button>

            <Dialog
                open={editing !== null}
                onOpenChange={(value) => !value && setEditing(null)}
            >
                <DialogContent className="sm:max-w-md">
                    {editing === "edit" && (
                        <>
                            <DialogHeader>
                                <DialogTitle>{i18n("Edit thing")}</DialogTitle>
                                <DialogDescription>
                                    {entity.scope === "org"
                                        ? i18n(
                                              "Changes apply to everyone and to every transcript that links to it.",
                                          )
                                        : i18n(
                                              "Changes apply to every transcript that links to it.",
                                          )}
                                </DialogDescription>
                            </DialogHeader>
                            <div className="space-y-2">
                                <Input
                                    value={name}
                                    maxLength={200}
                                    onChange={(event) =>
                                        setName(event.target.value)
                                    }
                                    aria-label={i18n("Name")}
                                />
                                <textarea
                                    value={description}
                                    maxLength={4000}
                                    onChange={(event) =>
                                        setDescription(event.target.value)
                                    }
                                    placeholder={i18n("Description (optional)")}
                                    aria-label={i18n("Description")}
                                    className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                />
                            </div>
                            {footer(
                                () => void saveEdit(),
                                i18n("Save"),
                                !name.trim(),
                            )}
                        </>
                    )}
                    {editing === "type" && (
                        <>
                            <DialogHeader>
                                <DialogTitle>
                                    {i18n("Change the type of {name}", {
                                        name: entity.name,
                                    })}
                                </DialogTitle>
                                <DialogDescription>
                                    {i18n(
                                        "Facts about it must still fit their relations; any that would not are named, to change or erase first.",
                                    )}
                                </DialogDescription>
                            </DialogHeader>
                            <select
                                value={typeKey}
                                onChange={(event) =>
                                    setTypeKey(event.target.value)
                                }
                                aria-label={i18n("Kind of thing")}
                                className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                {types.map((type) => (
                                    <option key={type.key} value={type.key}>
                                        {type.label}
                                    </option>
                                ))}
                            </select>
                            {footer(() => void saveType(), i18n("Save"))}
                        </>
                    )}
                    {editing === "merge" && (
                        <>
                            <DialogHeader>
                                <DialogTitle>
                                    {i18n("Merge {name} into…", {
                                        name: entity.name,
                                    })}
                                </DialogTitle>
                                <DialogDescription>
                                    {i18n(
                                        "Its nicknames, facts and the transcripts linking to it move to the thing you choose.",
                                    )}
                                </DialogDescription>
                            </DialogHeader>
                            <select
                                value={targetId}
                                onChange={(event) =>
                                    setTargetId(event.target.value)
                                }
                                aria-label={i18n("Merge target")}
                                className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                <option value="">
                                    {i18n("Choose a thing")}
                                </option>
                                {candidates.map((candidate) => (
                                    <option
                                        key={candidate.id}
                                        value={candidate.id}
                                    >
                                        {candidate.name}
                                        {candidate.scope === "org"
                                            ? ` · ${i18n("Organization")}`
                                            : ""}
                                    </option>
                                ))}
                            </select>
                            {footer(
                                () => void merge(),
                                i18n("Merge"),
                                !targetId,
                            )}
                        </>
                    )}
                    {editing === "erase" && (
                        <>
                            <DialogHeader>
                                <DialogTitle>
                                    {i18n("Erase {name}?", {
                                        name: entity.name,
                                    })}
                                </DialogTitle>
                                <DialogDescription>
                                    {i18n(
                                        "Its nicknames, the facts about it and the corrections linking to it are erased too; transcripts show those words as they were heard.",
                                    )}
                                </DialogDescription>
                            </DialogHeader>
                            {footer(() => void erase(), i18n("Erase"))}
                        </>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}
