"use client";

import { UserRound, UserX } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { PeopleCombobox } from "@/components/people/people-combobox";
import type { PickablePerson } from "@/components/people/people-search-list";
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
    /** The heard name still needs a person chosen. */
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
 * Choose the viewer, a recording speaker, another Almanac person, or nobody.
 * Someone without an email is marked because the task shows in nobody's own list.
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

    const offered = new Map(
        (people ?? [])
            .filter((person) => !organizationOnly || person.scope === "org")
            .map((person) => [
                person.id,
                {
                    id: person.id,
                    name: person.displayName,
                    email: person.primaryEmail,
                    self: person.self,
                },
            ]),
    );
    for (const speaker of speakers) {
        const person = offered.get(speaker.personId);
        if (person) person.name = speaker.name;
        else if (!organizationOnly) {
            offered.set(speaker.personId, {
                id: speaker.personId,
                name: speaker.name,
                email: null,
                self: false,
            });
        }
    }
    const pick = (person: { personId: string; name: string } | null) => {
        if (person?.personId !== value?.personId) onChange(person);
    };

    const label =
        value?.name ?? (hint ? `${hint}${check ? "" : "?"}` : i18n("Nobody"));
    return (
        <PeopleCombobox
            open={open}
            onOpenChange={setOpen}
            variant="pill"
            disabled={disabled}
            value={value?.personId ?? (hint ? undefined : "nobody")}
            valueLabel={
                <>
                    <UserRound className="size-3 shrink-0" aria-hidden />
                    <span className="truncate">{label}</span>
                    {check && !value && <span>{i18n("who is this?")}</span>}
                </>
            }
            className={cn(
                "max-w-44 transition-colors hover:bg-muted",
                check && "border-amber-500 text-amber-700 dark:text-amber-400",
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
            list={{
                people: [...offered.values()],
                context: {
                    heading: i18n("In this recording"),
                    ids: speakers.map((speaker) => speaker.personId),
                },
                peopleHeading: i18n("Almanac"),
                loadingLabel:
                    people === null ? i18n("Loading people…") : undefined,
                personDetail: (person) =>
                    people !== null &&
                    !person.email && (
                        <span
                            className="text-[10px] text-muted-foreground"
                            title={i18n(
                                "No email in the Almanac, so nobody gets it in their own list.",
                            )}
                        >
                            {i18n("no email")}
                        </span>
                    ),
            }}
            trailingEntries={[
                {
                    id: "nobody",
                    label: i18n("Nobody"),
                    icon: <UserX className="size-3.5" aria-hidden />,
                    onSelect: () => pick(null),
                },
            ]}
            onValueChange={(person) =>
                pick({ personId: person.id, name: person.name })
            }
        />
    );
}
