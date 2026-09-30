"use client";

import { Building2, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
    type PickedRecord,
    RecordPicker,
} from "@/components/almanac/record-picker";
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

/** A relation a fact may use, as the viewer's vocabulary has it. */
export interface FactRelation {
    key: string;
    label: string;
    subjectTypes: readonly string[];
    objectTypes: readonly string[];
    objectKind: "entity" | "literal";
    cardinality: "one" | "many";
    /** Adopted by the Organization: older facts use it, new ones do not. */
    adopted?: boolean;
}

type Other =
    | { kind: "literal"; text: string }
    | { kind: "person" | "entity"; id: string; name: string };

/**
 * Add a fact about a person or a thing by hand, or change what one says:
 * the relation (those that take the subject's type), then the other side,
 * someone or something from the Almanac, or text. On a relation that holds
 * one value at a time, replacing the current value is asked first.
 */
export function FactDialog({
    open,
    onOpenChange,
    subject,
    relations,
    typeLabels,
    editing,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    subject: { kind: "person" | "entity"; id: string; typeKey: string };
    relations: readonly FactRelation[];
    typeLabels: Record<string, string>;
    /** The fact being changed: its relation stays, the other side changes. */
    editing?: { factId: string; relationKey: string; other: Other };
}) {
    const i18n = useExtracted();
    const router = useRouter();
    const usable = relations.filter(
        (relation) =>
            !relation.adopted &&
            relation.subjectTypes.includes(subject.typeKey),
    );
    const [relationKey, setRelationKey] = useState(
        editing?.relationKey ?? usable[0]?.key ?? "",
    );
    const [other, setOther] = useState<Other | null>(editing?.other ?? null);
    const [text, setText] = useState(
        editing?.other.kind === "literal" ? editing.other.text : "",
    );
    const [picking, setPicking] = useState(!editing);
    const [replacing, setReplacing] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const relation = relations.find(
        (candidate) => candidate.key === relationKey,
    );
    const literal = relation?.objectKind === "literal";

    const object = () => {
        if (literal) return text.trim() ? { literal: text.trim() } : null;
        if (!other || other.kind === "literal") return null;
        return other.kind === "person"
            ? { personId: other.id }
            : { entityId: other.id };
    };

    async function save(expectedCurrentFactId?: string) {
        const value = object();
        if (!relation || !value) return;
        setSaving(true);
        try {
            const target =
                subject.kind === "person"
                    ? { personId: subject.id }
                    : { entityId: subject.id };
            const response = editing
                ? await fetch(`/api/knowledge/facts/${editing.factId}`, {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ object: value }),
                  })
                : await fetch("/api/knowledge/facts", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                          subject: target,
                          relationKey: relation.key,
                          object: value,
                          ...(expectedCurrentFactId
                              ? { expectedCurrentFactId }
                              : {}),
                      }),
                  });
            if (!response.ok) {
                const error = await parseApiError(response);
                const current = error.details?.currentFactId;
                if (response.status === 409 && editing) {
                    // Changed meanwhile (another tab, a Learn review): the
                    // page shows it as it is now.
                    toast.error(
                        i18n(
                            "This fact changed meanwhile. Here it is as it is now.",
                        ),
                    );
                    onOpenChange(false);
                    router.refresh();
                    return;
                }
                if (response.status === 409 && typeof current === "string") {
                    setReplacing(current);
                    return;
                }
                toast.error(error.error || i18n("Could not keep this fact"));
                return;
            }
            onOpenChange(false);
            router.refresh();
        } finally {
            setSaving(false);
        }
    }

    const pick = (record: PickedRecord) => {
        setOther({ kind: record.kind, id: record.id, name: record.name });
        setPicking(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        {editing ? i18n("Change fact") : i18n("Add a fact")}
                    </DialogTitle>
                    <DialogDescription>
                        {i18n(
                            "Facts typed by hand are kept until you change or erase them. Health, family, personality, performance and demographics are not kept.",
                        )}
                    </DialogDescription>
                </DialogHeader>

                {replacing ? (
                    <p className="text-sm">
                        {i18n(
                            "“{relation}” holds one value at a time, and it has one already. Replace it?",
                            { relation: relation?.label ?? relationKey },
                        )}
                    </p>
                ) : (
                    <div className="space-y-3">
                        <select
                            value={relationKey}
                            disabled={Boolean(editing)}
                            onChange={(event) => {
                                setRelationKey(event.target.value);
                                setOther(null);
                                setPicking(true);
                            }}
                            aria-label={i18n("Relation")}
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            {(editing ? relations : usable).map((candidate) => (
                                <option
                                    key={candidate.key}
                                    value={candidate.key}
                                >
                                    {candidate.label}
                                </option>
                            ))}
                        </select>
                        {literal ? (
                            <Input
                                value={text}
                                maxLength={500}
                                onChange={(event) =>
                                    setText(event.target.value)
                                }
                                aria-label={i18n("Text")}
                                placeholder={i18n(
                                    "e.g. a role, or what a term means",
                                )}
                            />
                        ) : other && other.kind !== "literal" && !picking ? (
                            <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                                <span className="inline-flex min-w-0 items-center gap-1.5">
                                    {other.kind === "person" ? (
                                        <UserRound className="size-3.5 text-muted-foreground" />
                                    ) : (
                                        <Building2 className="size-3.5 text-muted-foreground" />
                                    )}
                                    <span className="truncate">
                                        {other.name}
                                    </span>
                                </span>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setPicking(true)}
                                >
                                    {i18n("Change")}
                                </Button>
                            </div>
                        ) : relation ? (
                            <RecordPicker
                                types={relation.objectTypes}
                                exclude={subject.id}
                                typeLabels={typeLabels}
                                onPick={pick}
                            />
                        ) : (
                            <p className="text-sm text-muted-foreground">
                                {i18n(
                                    "No relation takes this kind of record yet.",
                                )}
                            </p>
                        )}
                    </div>
                )}

                <DialogFooter>
                    <Button
                        variant="outline"
                        disabled={saving}
                        onClick={() =>
                            replacing ? setReplacing(null) : onOpenChange(false)
                        }
                    >
                        {i18n("Cancel")}
                    </Button>
                    {replacing ? (
                        <Button
                            disabled={saving}
                            onClick={() => void save(replacing)}
                        >
                            {i18n("Replace")}
                        </Button>
                    ) : (
                        <Button
                            disabled={saving || !object()}
                            onClick={() => void save()}
                        >
                            {i18n("Save")}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
