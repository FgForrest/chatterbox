"use client";

import { Loader2, X } from "lucide-react";
import Link from "next/link";
import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import type { PlayAtTarget } from "@/components/playback/play-at-button";
import { PlayTurnButton } from "@/components/playback/play-turn-button";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { foldPersonSearch } from "@/lib/people/name-search";
import { PeopleSearchList, type PickablePerson } from "./people-search-list";

export interface SpeakerPickerProps {
    /** The raw provider label being named, e.g. `speaker_0`. */
    label: string;
    /** The confirmed person, whose Almanac page the picker links to. */
    personId?: string;
    /** Resolves true only after the attribution was persisted. */
    onPick: (
        choice: { personId: string } | { displayName: string },
    ) => Promise<boolean>;
    /**
     * Answer "nobody known". Offered when present; resolves true only after
     * the answer was persisted.
     */
    onMarkUnknown?: () => Promise<boolean>;
    onClose: () => void;
    /**
     * The Organization view names speakers with Organization people only; a
     * private person would leak into everyone's view.
     */
    organizationOnly?: boolean;
    voices?: readonly {
        speaker: string;
        label: string;
        name?: string;
        linked: boolean;
    }[];
    activeVoice?: string;
    onVoiceChange?: (label: string) => void;
    nextVoiceTurn?: (label: string) => PlayAtTarget | null;
    onUnlinkVoice?: (label: string) => Promise<boolean>;
}

/**
 * Name one speaker.
 *
 * Offers the people already known before the option to create somebody, since
 * after a few recordings the answer is almost always a repeat participant.
 * Typing a name that matches nobody creates them, so naming a new person is
 * one action rather than a detour through the People section.
 */
export function SpeakerPicker({
    label,
    personId,
    onPick,
    onMarkUnknown,
    onClose,
    organizationOnly = false,
    voices,
    activeVoice,
    onVoiceChange,
    nextVoiceTurn,
    onUnlinkVoice,
}: SpeakerPickerProps) {
    const i18n = useExtracted();
    const [knownPeople, setKnownPeople] = useState<PickablePerson[] | null>(
        null,
    );
    const [query, setQuery] = useState("");
    const [selectedPersonId, setSelectedPersonId] = useState<string | null>(
        null,
    );
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void fetch("/api/people")
            .then((response) =>
                response.ok ? response.json() : { people: [] },
            )
            .then((body: { people?: PickablePerson[] }) => {
                if (!cancelled) setKnownPeople(body.people ?? []);
            })
            .catch(() => {
                if (!cancelled) setKnownPeople([]);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const people = organizationOnly
        ? (knownPeople?.filter((person) => person.scope === "org") ?? null)
        : knownPeople;

    const trimmedQuery = query.trim();
    const spelling = trimmedQuery.toLowerCase();
    const folded = foldPersonSearch(trimmedQuery);
    const exactMatch = trimmedQuery
        ? people?.find(
              (person) => person.displayName.toLowerCase() === spelling,
          )
        : undefined;
    const foldedMatches =
        !exactMatch && folded
            ? people?.filter(
                  (person) => foldPersonSearch(person.displayName) === folded,
              )
            : undefined;
    const selectedPerson = (people ?? []).find(
        (person) => person.id === selectedPersonId,
    );
    const personToSelect =
        selectedPerson ??
        exactMatch ??
        (foldedMatches?.length === 1 ? foldedMatches[0] : undefined);
    const ambiguous = !personToSelect && (foldedMatches?.length ?? 0) > 1;
    const canSubmit =
        people !== null &&
        Boolean(personToSelect || (trimmedQuery && !ambiguous));
    const createsPerson = canSubmit && !personToSelect;

    async function submit(person = personToSelect) {
        if (
            people === null ||
            (!person && (!trimmedQuery || ambiguous)) ||
            submitting
        )
            return;
        setSubmitting(true);
        const saved = await onPick(
            person ? { personId: person.id } : { displayName: trimmedQuery },
        );
        setSubmitting(false);
        if (saved) onClose();
    }

    async function markUnknown() {
        if (!onMarkUnknown || submitting) return;
        setSubmitting(true);
        const saved = await onMarkUnknown();
        setSubmitting(false);
        if (saved) onClose();
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {i18n("Identify {speaker}", { speaker: label })}
                    </DialogTitle>
                    <DialogDescription>
                        {i18n("Select an existing person or enter a new name.")}
                    </DialogDescription>
                </DialogHeader>

                {voices && (
                    <fieldset
                        className="space-y-1 rounded-md border bg-muted/20 p-2"
                        aria-label={i18n("Transcript speakers")}
                    >
                        {voices.map((voice) => (
                            <div
                                key={voice.speaker}
                                className="flex items-center gap-1"
                            >
                                <PlayTurnButton
                                    className="grid size-8 place-items-center"
                                    disabled={submitting}
                                    label={i18n(
                                        "Play the next turn of {name}",
                                        { name: voice.label },
                                    )}
                                    nextTurn={
                                        nextVoiceTurn
                                            ? () => nextVoiceTurn(voice.speaker)
                                            : undefined
                                    }
                                />
                                <Button
                                    size="sm"
                                    variant={
                                        activeVoice === voice.speaker
                                            ? "secondary"
                                            : "ghost"
                                    }
                                    className="min-w-0 flex-1 justify-start text-xs"
                                    disabled={submitting}
                                    aria-pressed={activeVoice === voice.speaker}
                                    onClick={() => {
                                        setQuery("");
                                        setSelectedPersonId(null);
                                        onVoiceChange?.(voice.speaker);
                                    }}
                                >
                                    {voice.label}
                                </Button>
                                {voice.linked && onUnlinkVoice && (
                                    <Button
                                        size="icon-sm"
                                        variant="ghost"
                                        disabled={submitting}
                                        aria-label={i18n(
                                            "Unlink {name} from {speaker}",
                                            {
                                                name: voice.name ?? "",
                                                speaker: voice.label,
                                            },
                                        )}
                                        onClick={async () => {
                                            if (submitting) return;
                                            setSubmitting(true);
                                            const saved = await onUnlinkVoice(
                                                voice.speaker,
                                            );
                                            setSubmitting(false);
                                            if (saved) onClose();
                                        }}
                                    >
                                        <X className="size-3" />
                                    </Button>
                                )}
                            </div>
                        ))}
                    </fieldset>
                )}
                {personId && (
                    <Button asChild variant="outline">
                        <Link href={`/almanac/${personId}`} onClick={onClose}>
                            {i18n("Open in Almanac")}
                        </Link>
                    </Button>
                )}
                <PeopleSearchList
                    framed
                    people={people?.map((person) => ({
                        ...person,
                        name: person.displayName,
                        email: person.primaryEmail,
                    }))}
                    label={i18n("Who is {speaker}?", { speaker: label })}
                    placeholder={i18n("Search people or enter a name")}
                    loadingLabel={
                        people === null ? i18n("Loading people…") : undefined
                    }
                    emptyLabel={i18n(
                        "No people yet. Enter a name to create one.",
                    )}
                    query={query}
                    onQueryChange={(value) => {
                        setQuery(value);
                        setSelectedPersonId(null);
                    }}
                    onSubmitQuery={(person) => void submit(person)}
                    disabled={submitting}
                    selection={{
                        id: personToSelect?.id ?? personId,
                        onSelect: (person) => {
                            setSelectedPersonId(person.id);
                            setQuery(person.displayName);
                        },
                    }}
                    create={
                        createsPerson
                            ? {
                                  label: (name) =>
                                      i18n("Create “{name}”", { name }),
                                  onSelect: () => void submit(),
                              }
                            : undefined
                    }
                />

                <DialogFooter>
                    {onMarkUnknown && (
                        <Button
                            variant="ghost"
                            className="sm:mr-auto"
                            onClick={() => void markUnknown()}
                            disabled={submitting}
                        >
                            {i18n("Unknown speaker")}
                        </Button>
                    )}
                    <Button
                        variant="outline"
                        onClick={onClose}
                        disabled={submitting}
                    >
                        {i18n("Cancel")}
                    </Button>
                    <Button
                        onClick={() => void submit()}
                        disabled={!canSubmit || submitting}
                    >
                        {submitting && (
                            <Loader2 className="mr-2 size-4 animate-spin" />
                        )}
                        {createsPerson ? i18n("Create") : i18n("Select")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
