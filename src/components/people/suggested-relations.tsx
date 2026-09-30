"use client";

import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getApiErrorMessage } from "@/lib/api-errors";

export interface SuggestedPhrase {
    id: string;
    phrase: string;
    count: number;
    status: "open" | "adopted" | "rejected";
}

interface TypeChoice {
    key: string;
    label: string;
}

/**
 * The relation phrases members suggested, for the organization account to
 * decide (Phase 6): alike ones grouped, each made an Organization
 * relation, pointed at one the Organization or the core has, or declined.
 */
export function SuggestedRelations({
    phrases,
    groups,
    entityTypes,
    relationTypes,
}: {
    phrases: SuggestedPhrase[];
    /** Phrase ids, alike ones together (`groupPhrases`). */
    groups: string[][];
    entityTypes: TypeChoice[];
    relationTypes: TypeChoice[];
}) {
    const i18n = useExtracted();
    const byId = new Map(phrases.map((phrase) => [phrase.id, phrase]));
    if (phrases.length === 0) {
        return (
            <p className="text-sm text-muted-foreground">
                {i18n("No suggestions yet.")}
            </p>
        );
    }
    return (
        <ul className="divide-y rounded-lg border">
            {groups.map((group) => (
                <li key={group.join(",")} className="space-y-3 p-3">
                    {group.length > 1 && (
                        <p className="text-xs text-muted-foreground">
                            {i18n("Alike: decide them together")}
                        </p>
                    )}
                    {group.map((id) => {
                        const phrase = byId.get(id);
                        return phrase ? (
                            <PhraseRow
                                key={id}
                                phrase={phrase}
                                entityTypes={entityTypes}
                                relationTypes={relationTypes}
                            />
                        ) : null;
                    })}
                </li>
            ))}
        </ul>
    );
}

function PhraseRow({
    phrase,
    entityTypes,
    relationTypes,
}: {
    phrase: SuggestedPhrase;
    entityTypes: TypeChoice[];
    relationTypes: TypeChoice[];
}) {
    const i18n = useExtracted();
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [mapTo, setMapTo] = useState(relationTypes[0]?.key ?? "");
    const [label, setLabel] = useState(phrase.phrase);
    const [subject, setSubject] = useState("person");
    // An entity type, or "" for a text value.
    const [object, setObject] = useState("");
    const [cardinality, setCardinality] = useState<"one" | "many">("many");

    const decide = async (body: Record<string, unknown>) => {
        setBusy(true);
        try {
            const response = await fetch(
                `/api/knowledge/proposals/${phrase.id}`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(body),
                },
            );
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not decide the suggestion"),
                    ),
                );
                return;
            }
            router.refresh();
        } finally {
            setBusy(false);
        }
    };

    const members = i18n("{count, plural, one {# member} other {# members}}", {
        count: phrase.count,
    });
    if (phrase.status !== "open") {
        return (
            <div className="flex items-center justify-between gap-4 text-sm">
                <span>{phrase.phrase}</span>
                <span className="text-muted-foreground">
                    {phrase.status === "adopted"
                        ? i18n("Adopted")
                        : i18n("Declined")}
                </span>
            </div>
        );
    }
    const select = "h-8 rounded-md border bg-background px-2 text-sm";
    return (
        <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-4">
                <span className="font-medium">"{phrase.phrase}"</span>
                <span className="text-muted-foreground">{members}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <select
                    className={select}
                    aria-label={i18n("Relation it means")}
                    value={mapTo}
                    onChange={(event) => setMapTo(event.target.value)}
                >
                    {relationTypes.map((type) => (
                        <option key={type.key} value={type.key}>
                            {type.label}
                        </option>
                    ))}
                </select>
                <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !mapTo}
                    onClick={() => void decide({ action: "map", key: mapTo })}
                >
                    {i18n("Means this relation")}
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void decide({ action: "reject" })}
                >
                    {i18n("Decline")}
                </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    className="h-8 w-48"
                    value={label}
                    aria-label={i18n("Name of the relation")}
                    onChange={(event) => setLabel(event.target.value)}
                />
                <select
                    className={select}
                    aria-label={i18n("Who or what it is about")}
                    value={subject}
                    onChange={(event) => setSubject(event.target.value)}
                >
                    {entityTypes.map((type) => (
                        <option key={type.key} value={type.key}>
                            {type.label}
                        </option>
                    ))}
                </select>
                <span aria-hidden>→</span>
                <select
                    className={select}
                    aria-label={i18n("What it relates to")}
                    value={object}
                    onChange={(event) => setObject(event.target.value)}
                >
                    <option value="">{i18n("a text")}</option>
                    {entityTypes.map((type) => (
                        <option key={type.key} value={type.key}>
                            {type.label}
                        </option>
                    ))}
                </select>
                <select
                    className={select}
                    aria-label={i18n("How many values")}
                    value={cardinality}
                    onChange={(event) =>
                        setCardinality(
                            event.target.value === "one" ? "one" : "many",
                        )
                    }
                >
                    <option value="many">{i18n("Many values")}</option>
                    <option value="one">{i18n("One value at a time")}</option>
                </select>
                <Button
                    size="sm"
                    disabled={busy || !label.trim()}
                    onClick={() =>
                        void decide({
                            action: "create",
                            spec: {
                                label: label.trim(),
                                subjectTypes: [subject],
                                objectTypes: object ? [object] : [],
                                objectKind: object ? "entity" : "literal",
                                cardinality,
                            },
                        })
                    }
                >
                    {i18n("Create as an Organization relation")}
                </Button>
            </div>
        </div>
    );
}
