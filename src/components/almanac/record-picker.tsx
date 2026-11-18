"use client";

import { Command, defaultFilter } from "cmdk";
import { Building2 } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import {
    PeopleSearchList,
    type PickablePerson,
} from "@/components/people/people-search-list";
import { useVocabularyLabels } from "@/lib/knowledge/vocabulary-labels";
import { getPasswordManagerAttributes } from "@/lib/password-manager";
import { foldPersonSearch } from "@/lib/people/name-search";

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
    const labels = useVocabularyLabels();
    const [records, setRecords] = useState<
        (PickedRecord & { self?: boolean })[] | null
    >(null);
    const [query, setQuery] = useState("");
    const offersPeople =
        kind !== "entity" && (!types || types.includes("person"));
    const offersThings =
        kind !== "person" &&
        (!types || types.some((type) => type !== "person"));

    useEffect(() => {
        let cancelled = false;
        const json = (url: string) =>
            fetch(url).then((response) => (response.ok ? response.json() : {}));
        void Promise.all([
            offersPeople ? json("/api/people") : {},
            offersThings ? json("/api/knowledge/entities") : {},
        ]).then(
            ([people, things]: [
                {
                    people?: PickablePerson[];
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
                        self: person.self,
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
    }, [offersPeople, offersThings]);

    const offered = (records ?? []).filter(
        (record) =>
            record.id !== exclude &&
            (!kind || record.kind === kind) &&
            (!types || types.includes(record.typeKey)),
    );

    const detail = (record: PickedRecord) => (
        <span className="shrink-0 text-xs text-muted-foreground">
            {labels.entityType(record.typeKey, typeLabels[record.typeKey])}
            {record.scope === "org" && (
                <span className="text-organization">{` · ${i18n("Organization")}`}</span>
            )}
        </span>
    );
    const searchLabel = i18n("Find a person or a thing");
    const loadingLabel = records === null ? i18n("Loading…") : undefined;
    const emptyLabel = i18n("Nobody and nothing of that name");

    if (offersPeople) {
        const people = offered.filter((record) => record.kind === "person");
        const search = foldPersonSearch(query);
        const things = offered
            .filter((record) => record.kind === "entity")
            .map((record) => ({
                record,
                score: query
                    ? defaultFilter(`${record.name} ${record.id}`, query)
                    : 1,
            }))
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score)
            .map(({ record }) => ({
                id: record.id,
                label: record.name,
                icon: (
                    <Building2
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden
                    />
                ),
                detail: detail(record),
                onSelect: () => onPick(record),
            }));
        const exactThing =
            search &&
            !people.some((person) => foldPersonSearch(person.name) === search)
                ? things.find(
                      (thing) => foldPersonSearch(thing.label) === search,
                  )
                : undefined;
        return (
            <PeopleSearchList
                framed
                label={searchLabel}
                loadingLabel={loadingLabel}
                emptyLabel={emptyLabel}
                query={query}
                onQueryChange={setQuery}
                people={people}
                selection={{ onSelect: onPick }}
                personDetail={detail}
                preferredEntry={exactThing}
                trailingEntries={things.filter((thing) => thing !== exactThing)}
            />
        );
    }

    return (
        <Command label={searchLabel} className="rounded-md border">
            <Command.Input
                asChild
                {...getPasswordManagerAttributes()}
                autoFocus
                placeholder={searchLabel}
                className="h-9 w-full border-b bg-transparent px-3 text-sm outline-none"
            >
                <input type="search" />
            </Command.Input>
            <Command.List className="max-h-56 overflow-y-auto p-1">
                <Command.Empty className="px-2 py-3 text-sm text-muted-foreground">
                    {loadingLabel ?? emptyLabel}
                </Command.Empty>
                {offered.map((record) => (
                    <Command.Item
                        key={record.id}
                        value={`${record.name} ${record.id}`}
                        onSelect={() => onPick(record)}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm data-[selected=true]:bg-muted"
                    >
                        <Building2 className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">
                            {record.name}
                        </span>
                        {detail(record)}
                    </Command.Item>
                ))}
            </Command.List>
        </Command>
    );
}
