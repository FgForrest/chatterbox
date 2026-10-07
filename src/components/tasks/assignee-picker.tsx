"use client";

import { Check, ChevronDown, Search, UserRound, UserX } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import type { PickablePerson } from "@/components/people/speaker-picker";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** A person the recording's speakers are, offered first. */
export interface SpeakerChoice {
    personId: string;
    name: string;
}

interface AssigneePickerProps {
    value: { personId: string; name: string } | null;
    /** A name heard with no person of the Almanac matching it. */
    hint?: string | null;
    /** Matched on a first name alone: worth a look before accepting. */
    check?: boolean;
    speakers: readonly SpeakerChoice[];
    /** On a shared recording only the Organization's people are offered. */
    organizationOnly: boolean;
    disabled?: boolean;
    onChange: (person: { personId: string; name: string } | null) => void;
}

let peopleRequest: Promise<PickablePerson[]> | null = null;

/** The Almanac's people, read once per page. */
function loadPeople(): Promise<PickablePerson[]> {
    peopleRequest ??= fetch("/api/people")
        .then((response) => (response.ok ? response.json() : { people: [] }))
        .then((body: { people?: PickablePerson[] }) => body.people ?? [])
        .catch(() => {
            peopleRequest = null;
            return [];
        });
    return peopleRequest;
}

/**
 * Who has to do a task: the recording's speakers first, then anyone in the
 * Almanac, or nobody. Someone without an email is marked: without one, no
 * user is them, and the task shows in nobody's own list.
 */
export function AssigneePicker({
    value,
    hint,
    check = false,
    speakers,
    organizationOnly,
    disabled = false,
    onChange,
}: AssigneePickerProps) {
    const i18n = useExtracted();
    const [open, setOpen] = useState(false);
    const [people, setPeople] = useState<PickablePerson[] | null>(null);
    const [query, setQuery] = useState("");

    useEffect(() => {
        if (!open || people) return;
        let cancelled = false;
        void loadPeople().then((list) => {
            if (!cancelled) setPeople(list);
        });
        return () => {
            cancelled = true;
        };
    }, [open, people]);

    const others = useMemo(() => {
        const speakerIds = new Set(speakers.map((speaker) => speaker.personId));
        const needle = query.trim().toLowerCase();
        return (people ?? [])
            .filter((person) => !organizationOnly || person.scope === "org")
            .filter((person) => !speakerIds.has(person.id))
            .filter(
                (person) =>
                    !needle ||
                    person.displayName.toLowerCase().includes(needle) ||
                    person.primaryEmail?.toLowerCase().includes(needle),
            )
            .slice(0, 12);
    }, [people, speakers, organizationOnly, query]);
    const emailOf = useMemo(
        () => new Map((people ?? []).map((p) => [p.id, p.primaryEmail])),
        [people],
    );
    const shownSpeakers = speakers.filter(
        (speaker) =>
            !query.trim() ||
            speaker.name.toLowerCase().includes(query.trim().toLowerCase()),
    );

    const pick = (person: { personId: string; name: string } | null) => {
        setOpen(false);
        setQuery("");
        if (person?.personId !== value?.personId) onChange(person);
    };

    const label = value?.name ?? (hint ? `${hint}?` : i18n("Nobody"));
    return (
        <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger
                disabled={disabled}
                className={cn(
                    "inline-flex max-w-44 items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent",
                    check &&
                        "border-amber-500 text-amber-700 dark:text-amber-400",
                    !value && "text-muted-foreground",
                )}
                aria-label={i18n("Assigned to {name}", { name: label })}
                title={
                    check
                        ? i18n("Matched by first name only. Check who it is.")
                        : hint && !value
                          ? i18n("Heard “{name}”, who is not in the Almanac.", {
                                name: hint,
                            })
                          : undefined
                }
            >
                <UserRound className="size-3 shrink-0" />
                <span className="truncate">{label}</span>
                {!disabled && <ChevronDown className="size-3 shrink-0" />}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
                <div className="relative p-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        autoFocus
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => event.stopPropagation()}
                        placeholder={i18n("Search people")}
                        aria-label={i18n("Search people")}
                        className="h-8 pl-8 text-sm"
                    />
                </div>
                {shownSpeakers.length > 0 && (
                    <>
                        <DropdownMenuLabel className="text-xs text-muted-foreground">
                            {i18n("In this recording")}
                        </DropdownMenuLabel>
                        {shownSpeakers.map((speaker) => (
                            <PersonItem
                                key={speaker.personId}
                                name={speaker.name}
                                selected={value?.personId === speaker.personId}
                                noEmail={
                                    people !== null &&
                                    !emailOf.get(speaker.personId)
                                }
                                onSelect={() => pick(speaker)}
                            />
                        ))}
                    </>
                )}
                {others.length > 0 && (
                    <>
                        <DropdownMenuLabel className="text-xs text-muted-foreground">
                            {i18n("Almanac")}
                        </DropdownMenuLabel>
                        {others.map((person) => (
                            <PersonItem
                                key={person.id}
                                name={person.displayName}
                                selected={value?.personId === person.id}
                                noEmail={!person.primaryEmail}
                                onSelect={() =>
                                    pick({
                                        personId: person.id,
                                        name: person.displayName,
                                    })
                                }
                            />
                        ))}
                    </>
                )}
                {people === null && (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                        {i18n("Loading people…")}
                    </p>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => pick(null)}>
                    <UserX className="size-3.5" /> {i18n("Nobody")}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function PersonItem({
    name,
    selected,
    noEmail,
    onSelect,
}: {
    name: string;
    selected: boolean;
    noEmail: boolean;
    onSelect: () => void;
}) {
    const i18n = useExtracted();
    return (
        <DropdownMenuItem onSelect={onSelect}>
            <span className="min-w-0 flex-1 truncate">{name}</span>
            {noEmail && (
                <span
                    className="text-[10px] text-muted-foreground"
                    title={i18n(
                        "No email in the Almanac, so nobody gets it in their own list.",
                    )}
                >
                    {i18n("no email")}
                </span>
            )}
            {selected && <Check className="size-3.5 text-primary" />}
        </DropdownMenuItem>
    );
}
