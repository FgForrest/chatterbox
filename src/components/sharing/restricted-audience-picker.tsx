"use client";

import { X } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { HelpLink } from "@/components/help/help-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useRestrictedFolders } from "./restricted-folder-context";

export interface AudiencePerson {
    id: string;
    name: string | null;
    email: string;
}

/** The colleague search and selected audience used by creation and restriction. */
export function RestrictedAudiencePicker({
    selected,
    onChange,
    fixed = [],
    excludedUserIds = [],
    disabled = false,
}: {
    selected: AudiencePerson[];
    onChange: (people: AudiencePerson[]) => void;
    fixed?: AudiencePerson[];
    excludedUserIds?: string[];
    disabled?: boolean;
}) {
    const i18n = useExtracted();
    const [query, setQuery] = useState("");
    const [people, setPeople] = useState<AudiencePerson[]>([]);
    const searchError = i18n("Could not find colleagues");
    useEffect(() => {
        if (query.trim().length < 2 || disabled) {
            setPeople([]);
            return;
        }
        const abort = new AbortController();
        const timer = setTimeout(() => {
            void fetch(`/api/shares/people?q=${encodeURIComponent(query)}`, {
                signal: abort.signal,
            })
                .then(async (response) => {
                    if (!response.ok) throw new Error(searchError);
                    return response.json() as Promise<{
                        people: AudiencePerson[];
                    }>;
                })
                .then((data) => setPeople(data.people))
                .catch((error) => {
                    if (!abort.signal.aborted) toast.error(String(error));
                });
        }, 250);
        return () => {
            abort.abort();
            clearTimeout(timer);
        };
    }, [query, disabled, searchError]);
    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
                {fixed.map((person) => (
                    <span
                        key={person.id}
                        className="rounded-full border px-3 py-1 text-sm"
                    >
                        {person.name ?? person.email}
                    </span>
                ))}
                {selected.map((person) => (
                    <span
                        key={person.id}
                        className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm"
                    >
                        {person.name ?? person.email}
                        <button
                            type="button"
                            disabled={disabled}
                            aria-label={i18n("Remove {name}", {
                                name: person.name ?? person.email,
                            })}
                            onClick={() =>
                                onChange(
                                    selected.filter(
                                        (entry) => entry.id !== person.id,
                                    ),
                                )
                            }
                        >
                            <X className="size-3" />
                        </button>
                    </span>
                ))}
            </div>
            <Input
                type="search"
                value={query}
                disabled={disabled || selected.length >= 20}
                onChange={(event) => setQuery(event.target.value)}
                aria-label={i18n("Colleague's name or email")}
                placeholder={i18n("Colleague's name or email")}
            />
            {people
                .filter(
                    (person) =>
                        !excludedUserIds.includes(person.id) &&
                        ![...fixed, ...selected].some(
                            (entry) => entry.id === person.id,
                        ),
                )
                .map((person) => (
                    <Button
                        key={person.id}
                        variant="ghost"
                        className="justify-start"
                        type="button"
                        disabled={disabled || selected.length >= 20}
                        onClick={() => {
                            onChange([...selected, person]);
                            setQuery("");
                        }}
                    >
                        {person.name ?? person.email}
                    </Button>
                ))}
            <p className="text-xs text-muted-foreground">
                {i18n("Curators always see restricted folders.")}
            </p>
        </div>
    );
}

export function RestrictedFolderMeaning() {
    const i18n = useExtracted();
    return (
        <div className="flex flex-col gap-2 rounded-lg border border-restricted/30 bg-restricted/5 p-3 text-sm">
            <h3 className="font-medium">{i18n("What this means")}</h3>
            <ul className="flex list-disc flex-col gap-2 pl-4">
                <li>
                    {i18n(
                        "Everyone sees the folder's name. Only its audience and curators see its recordings, mail, tasks and agendas.",
                    )}
                </li>
                <li>
                    {i18n(
                        "The Organization Almanac does not learn from it. Speaker names and facts stay with whoever added the item.",
                    )}
                </li>
                <li>
                    {i18n(
                        "A curator or the folder's manager can open it to the whole Organization later.",
                    )}
                </li>
            </ul>
        </div>
    );
}

/** Creation controls shared by the dialog and inline folder form. */
export function RestrictedCreationFields({
    restricted,
    onRestrictedChange,
    audience,
    onAudienceChange,
    disabled = false,
}: {
    restricted: boolean;
    onRestrictedChange: (value: boolean) => void;
    audience: AudiencePerson[];
    onAudienceChange: (people: AudiencePerson[]) => void;
    disabled?: boolean;
}) {
    const i18n = useExtracted();
    const { writable, userId } = useRestrictedFolders();
    if (!writable) return null;
    return (
        <>
            <div className="flex items-start gap-3 rounded-lg border p-3">
                <Switch
                    checked={restricted}
                    onCheckedChange={onRestrictedChange}
                    disabled={disabled}
                    aria-label={i18n("Restricted folder")}
                />
                <span>
                    <span className="block font-medium">
                        {i18n("Restricted folder")}{" "}
                        <HelpLink
                            topic="folders.restricted"
                            label={i18n("restricted folders")}
                        />
                    </span>
                    <span className="text-sm text-muted-foreground">
                        {i18n(
                            "Only the people you choose and curators will see what is inside.",
                        )}
                    </span>
                </span>
            </div>
            {restricted && (
                <>
                    <RestrictedAudiencePicker
                        selected={audience}
                        onChange={onAudienceChange}
                        fixed={[{ id: userId, name: i18n("you"), email: "" }]}
                        disabled={disabled}
                    />
                    <RestrictedFolderMeaning />
                </>
            )}
        </>
    );
}
