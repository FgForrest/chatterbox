"use client";

import { Command } from "cmdk";
import { Check, UserPlus } from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import {
    type ReactNode,
    type Ref,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { getPasswordManagerAttributes } from "@/lib/password-manager";
import { compareNamesBySurname } from "@/lib/people/name-order";
import {
    matchesPersonSearch,
    personSearchWords,
} from "@/lib/people/name-search";
import { cn } from "@/lib/utils";

export interface PickablePerson {
    id: string;
    displayName: string;
    primaryEmail: string | null;
    scope?: "personal" | "org";
    self?: boolean;
}

export interface PeopleListPerson {
    id: string;
    name: string | null;
    email?: string | null;
    self?: boolean;
}

export interface PeopleListEntry {
    id: string;
    label: string;
    icon?: ReactNode;
    detail?: ReactNode;
    disabled?: boolean;
    onSelect: () => void;
}

export interface PeopleSearchListProps<T extends PeopleListPerson> {
    people?: readonly T[];
    search?: {
        load: (query: string, signal: AbortSignal) => Promise<readonly T[]>;
        onError: (error: unknown) => void;
        minLength?: number;
    };
    selection?:
        | { id?: string; onSelect: (person: T) => void }
        | { ids: readonly string[]; onToggle: (person: T) => void };
    pinnedIds?: readonly string[];
    excludedIds?: readonly string[];
    context?: { ids: readonly string[]; heading: string };
    peopleHeading?: string;
    leadingEntries?: readonly PeopleListEntry[];
    trailingEntries?: readonly PeopleListEntry[];
    preferredEntry?: PeopleListEntry;
    create?: {
        label: (name: string) => string;
        onSelect: (name: string) => void;
    };
    personDetail?: (person: T) => ReactNode;
    personDisabled?: (person: T) => boolean;
    label?: string;
    placeholder?: string;
    emptyLabel?: string;
    loadingLabel?: string;
    query?: string;
    onQueryChange?: (query: string) => void;
    onSubmitQuery?: (person?: T) => void;
    disabled?: boolean;
    autoFocus?: boolean;
    framed?: boolean;
    listRef?: Ref<HTMLDivElement>;
    onEscape?: () => void;
    onTab?: () => void;
}

const rowClass =
    "flex cursor-default items-center gap-2 rounded px-3 py-2 text-sm data-[selected=true]:bg-accent data-[disabled=true]:opacity-50";
const groupClass =
    "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground";

function personName(person: PeopleListPerson): string {
    return person.name || person.email || "";
}

function usePeopleSearch<T extends PeopleListPerson>(
    search: PeopleSearchListProps<T>["search"],
    query: string,
) {
    const [result, setResult] = useState<{
        query: string;
        people: readonly T[];
    }>();
    const { load, onError, minLength = 2 } = search ?? {};
    const searching = Boolean(load && query.length >= minLength);
    useEffect(() => {
        setResult(undefined);
        if (!load || !searching) return;
        const controller = new AbortController();
        const timer = setTimeout(() => {
            void load(query, controller.signal).then(
                (people) => {
                    if (!controller.signal.aborted)
                        setResult({ query, people });
                },
                (error) => {
                    if (controller.signal.aborted) return;
                    setResult({ query, people: [] });
                    onError?.(error);
                },
            );
        }, 250);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [load, onError, query, searching]);
    return {
        result:
            searching && result?.query === query ? result.people : undefined,
        searching,
    };
}

/** The searchable people list used in popups, dialogs and inline forms. */
export function PeopleSearchList<T extends PeopleListPerson>({
    people,
    search,
    selection,
    pinnedIds,
    excludedIds,
    context,
    peopleHeading,
    leadingEntries = [],
    trailingEntries = [],
    preferredEntry,
    create,
    personDetail,
    personDisabled,
    label,
    placeholder,
    emptyLabel,
    loadingLabel,
    query: controlledQuery,
    onQueryChange,
    onSubmitQuery,
    disabled = false,
    autoFocus = true,
    framed = false,
    listRef,
    onEscape,
    onTab,
}: PeopleSearchListProps<T>) {
    const i18n = useExtracted();
    const locale = useLocale();
    const searchLabel = label ?? i18n("Search people");
    const [internalQuery, setQuery] = useState("");
    const query = controlledQuery ?? internalQuery;
    const trimmedQuery = query.trim();
    const { result, searching } = usePeopleSearch(search, trimmedQuery);
    const loading = search ? searching && !result : Boolean(loadingLabel);
    const matches = useMemo(() => {
        const compare = compareNamesBySurname(locale);
        const terms = personSearchWords(trimmedQuery);
        return (result ?? people ?? [])
            .filter(
                (person) =>
                    !excludedIds?.includes(person.id) &&
                    (!trimmedQuery ||
                        (terms.length > 0 &&
                            matchesPersonSearch(
                                terms,
                                person.name ?? "",
                                person.email,
                            ))),
            )
            .sort((a, b) => compare(personName(a), personName(b)));
    }, [result, people, excludedIds, trimmedQuery, locale]);
    const pinned = [];
    const contextPeople = new Map<string, T>();
    const others = [];
    const contextIds = new Set(context?.ids);
    for (const person of matches) {
        if (pinnedIds?.includes(person.id) ?? person.self) pinned.push(person);
        else if (contextIds.has(person.id))
            contextPeople.set(person.id, person);
        else others.push(person);
    }
    const pinnedIdSet = new Set(pinned.map((person) => person.id));
    const contextual = Array.from(contextIds).flatMap((id) => {
        const person = contextPeople.get(id);
        return person ? [person] : [];
    });

    const personValue = (id: string) => `person:${id}`;
    const entryValue = (id: string) => `entry:${id}`;
    const availablePeople = [...pinned, ...contextual, ...others].filter(
        (person) => !personDisabled?.(person),
    );
    const enabledLeading = leadingEntries.filter((entry) => !entry.disabled);
    const enabledTrailing = trailingEntries.filter((entry) => !entry.disabled);
    const offerCreate = Boolean(create && trimmedQuery);
    const preferredValue =
        preferredEntry && !preferredEntry.disabled
            ? entryValue(preferredEntry.id)
            : undefined;
    const values = disabled
        ? []
        : [
              ...(preferredValue ? [preferredValue] : []),
              ...enabledLeading.map((entry) => entryValue(entry.id)),
              ...availablePeople.map((person) => personValue(person.id)),
              ...enabledTrailing.map((entry) => entryValue(entry.id)),
              ...(offerCreate ? ["create"] : []),
          ];
    const [active, setActive] = useState("");
    const navigatedQuery = useRef<string | null>(null);
    const activeValue = values.includes(active)
        ? active
        : preferredValue && values.includes(preferredValue)
          ? preferredValue
          : trimmedQuery
            ? ((availablePeople[0] && personValue(availablePeople[0].id)) ??
              (offerCreate
                  ? "create"
                  : enabledTrailing[0] && entryValue(enabledTrailing[0].id)) ??
              "")
            : (values[0] ?? "");
    const [activeId, setActiveId] = useState<string>();
    const activeOptionRef = useCallback((item: HTMLDivElement | null) => {
        setActiveId(item?.id);
    }, []);

    const selected = (id: string) =>
        selection &&
        ("ids" in selection ? selection.ids.includes(id) : selection.id === id);
    const check = (id: string) =>
        selected(id) && (
            <Check className="size-4 shrink-0 text-primary" aria-hidden />
        );
    const renderEntry = (entry: PeopleListEntry) => (
        <Command.Item
            key={entry.id}
            value={entryValue(entry.id)}
            ref={
                entryValue(entry.id) === activeValue
                    ? activeOptionRef
                    : undefined
            }
            aria-label={entry.label}
            aria-checked={Boolean(selected(entry.id))}
            disabled={disabled || entry.disabled}
            onSelect={entry.onSelect}
            className={rowClass}
        >
            {entry.icon}
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.detail}
            {check(entry.id)}
        </Command.Item>
    );
    const renderPerson = (person: T) => {
        const name = personName(person);
        return (
            <Command.Item
                key={person.id}
                value={personValue(person.id)}
                ref={
                    personValue(person.id) === activeValue
                        ? activeOptionRef
                        : undefined
                }
                aria-checked={Boolean(selected(person.id))}
                disabled={disabled || personDisabled?.(person)}
                onSelect={() => {
                    navigatedQuery.current = null;
                    if (selection && "ids" in selection)
                        selection.onToggle(person);
                    else selection?.onSelect(person);
                }}
                className={rowClass}
            >
                <span
                    aria-hidden="true"
                    className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium"
                >
                    {Array.from(name)[0]?.toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">{name}</span>{" "}
                        {pinnedIdSet.has(person.id) && (
                            <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                                {i18n("You")}
                            </span>
                        )}
                    </span>
                    {person.email && person.email !== name && (
                        <span className="block truncate text-xs text-muted-foreground">
                            {person.email}
                        </span>
                    )}
                </span>
                {personDetail?.(person)}
                {check(person.id)}
            </Command.Item>
        );
    };

    return (
        <Command
            shouldFilter={false}
            disablePointerSelection={Boolean(onSubmitQuery)}
            vimBindings={!onSubmitQuery}
            value={activeValue}
            onValueChange={setActive}
            label={searchLabel}
            className={cn(
                "flex min-h-0 flex-col",
                framed && "rounded-md border",
            )}
            onKeyDown={(event) => {
                if (event.key === "Tab") onTab?.();
                if (event.key === "Escape" && onEscape) {
                    event.preventDefault();
                    event.stopPropagation();
                    onEscape();
                }
            }}
        >
            <Command.Input
                asChild
                {...getPasswordManagerAttributes()}
                autoFocus={autoFocus}
                disabled={disabled}
                value={query}
                onValueChange={(value) => {
                    navigatedQuery.current = null;
                    setActive("");
                    setQuery(value);
                    onQueryChange?.(value);
                }}
                placeholder={placeholder ?? searchLabel}
                aria-label={searchLabel}
                className={cn(
                    "w-full shrink-0 px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    framed
                        ? "rounded-t-md border-b bg-transparent"
                        : "mb-2 rounded border bg-background",
                )}
            >
                <input
                    type="search"
                    aria-activedescendant={activeId}
                    onKeyDown={(event) => {
                        if (event.key === "Home" || event.key === "End") {
                            event.stopPropagation();
                        }
                        if (
                            !onSubmitQuery ||
                            disabled ||
                            event.nativeEvent.isComposing ||
                            event.keyCode === 229
                        )
                            return;
                        if (event.key === "Enter") {
                            event.preventDefault();
                            const person =
                                navigatedQuery.current === query
                                    ? availablePeople.find(
                                          (person) =>
                                              personValue(person.id) ===
                                              activeValue,
                                      )
                                    : undefined;
                            onSubmitQuery(person);
                        } else if (
                            (event.key === "ArrowDown" ||
                                event.key === "ArrowUp") &&
                            navigatedQuery.current !== query &&
                            values.length > 0
                        ) {
                            event.preventDefault();
                            navigatedQuery.current = query;
                            setActive(
                                values[
                                    event.key === "ArrowDown"
                                        ? 0
                                        : values.length - 1
                                ],
                            );
                        }
                    }}
                />
            </Command.Input>
            <Command.List
                label={searchLabel}
                aria-multiselectable={
                    selection && "ids" in selection ? true : undefined
                }
                ref={listRef}
                className={cn(
                    "min-h-0 overflow-y-auto overscroll-contain",
                    framed ? "max-h-56 p-1" : "max-h-[60vh]",
                )}
            >
                {preferredEntry && renderEntry(preferredEntry)}
                {leadingEntries.map(renderEntry)}
                {pinned.map(renderPerson)}
                {context && contextual.length > 0 && (
                    <Command.Group
                        heading={context.heading}
                        className={groupClass}
                    >
                        {contextual.map(renderPerson)}
                    </Command.Group>
                )}
                {peopleHeading && others.length > 0 ? (
                    <Command.Group
                        heading={peopleHeading}
                        className={groupClass}
                    >
                        {others.map(renderPerson)}
                    </Command.Group>
                ) : (
                    others.map(renderPerson)
                )}
                {trailingEntries.map(renderEntry)}
                {offerCreate && create && (
                    <Command.Item
                        value="create"
                        ref={
                            activeValue === "create"
                                ? activeOptionRef
                                : undefined
                        }
                        disabled={disabled}
                        onSelect={() => create.onSelect(trimmedQuery)}
                        className={rowClass}
                    >
                        <UserPlus className="size-4 shrink-0" aria-hidden />
                        {create.label(trimmedQuery)}
                    </Command.Item>
                )}
                {loading ? (
                    <output className="block px-3 py-2 text-sm text-muted-foreground">
                        {loadingLabel ?? i18n("Loading people…")}
                    </output>
                ) : (
                    !disabled &&
                    (!search || searching) &&
                    matches.length === 0 &&
                    trailingEntries.length === 0 &&
                    !preferredEntry &&
                    !offerCreate &&
                    (trimmedQuery || leadingEntries.length === 0) && (
                        <output className="block px-3 py-2 text-sm text-muted-foreground">
                            {emptyLabel ?? i18n("No matches.")}
                        </output>
                    )
                )}
            </Command.List>
        </Command>
    );
}
