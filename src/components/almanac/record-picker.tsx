"use client";

import { Command } from "cmdk";
import { Building2, UserRound } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";

/** A person or a thing, as the picker offers it. */
export interface PickedRecord {
    kind: "person" | "entity";
    id: string;
    name: string;
    /** `person` for people. */
    typeKey: string;
    scope: "personal" | "org";
}

/**
 * Search the people and things the viewer sees and pick one: the other
 * side of a fact, say. `types` narrows it to those a relation takes
 * (`person` for people); `exclude` leaves one out (the page's own record).
 */
export function RecordPicker({
    types,
    kind,
    exclude,
    typeLabels = {},
    onPick,
}: {
    types?: readonly string[];
    /** Only people, or only things. */
    kind?: "person" | "entity";
    exclude?: string;
    typeLabels?: Record<string, string>;
    onPick: (record: PickedRecord) => void;
}) {
    const i18n = useExtracted();
    const [records, setRecords] = useState<PickedRecord[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        const json = (url: string) =>
            fetch(url).then((response) => (response.ok ? response.json() : {}));
        void Promise.all([
            json("/api/people"),
            json("/api/knowledge/entities"),
        ]).then(
            ([people, things]: [
                {
                    people?: {
                        id: string;
                        displayName: string;
                        scope?: "personal" | "org";
                    }[];
                },
                {
                    entities?: {
                        id: string;
                        name: string;
                        typeKey: string;
                        scope: "personal" | "org";
                    }[];
                },
            ]) => {
                if (cancelled) return;
                setRecords([
                    ...(people.people ?? []).map((person) => ({
                        kind: "person" as const,
                        id: person.id,
                        name: person.displayName,
                        typeKey: "person",
                        scope: person.scope ?? ("personal" as const),
                    })),
                    ...(things.entities ?? []).map((thing) => ({
                        kind: "entity" as const,
                        id: thing.id,
                        name: thing.name,
                        typeKey: thing.typeKey,
                        scope: thing.scope,
                    })),
                ]);
            },
            () => {
                if (!cancelled) setRecords([]);
            },
        );
        return () => {
            cancelled = true;
        };
    }, []);

    const offered = (records ?? []).filter(
        (record) =>
            record.id !== exclude &&
            (!kind || record.kind === kind) &&
            (!types || types.includes(record.typeKey)),
    );

    return (
        <Command
            label={i18n("Find a person or a thing")}
            className="rounded-md border"
        >
            <Command.Input
                autoFocus
                placeholder={i18n("Find a person or a thing")}
                className="h-9 w-full border-b bg-transparent px-3 text-sm outline-none"
            />
            <Command.List className="max-h-56 overflow-y-auto p-1">
                <Command.Empty className="px-2 py-3 text-sm text-muted-foreground">
                    {records === null
                        ? i18n("Loading…")
                        : i18n("Nobody and nothing of that name")}
                </Command.Empty>
                {offered.map((record) => {
                    const Icon =
                        record.kind === "person" ? UserRound : Building2;
                    return (
                        <Command.Item
                            key={record.id}
                            value={`${record.name} ${record.id}`}
                            onSelect={() => onPick(record)}
                            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm data-[selected=true]:bg-muted"
                        >
                            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate">
                                {record.name}
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                                {record.kind === "person"
                                    ? i18n("Person")
                                    : (typeLabels[record.typeKey] ??
                                      record.typeKey)}
                                {record.scope === "org" &&
                                    ` · ${i18n("Organization")}`}
                            </span>
                        </Command.Item>
                    );
                })}
            </Command.List>
        </Command>
    );
}
