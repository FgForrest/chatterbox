import type { MeetingAttendee } from "@/lib/integrations/google/meeting-roster";
import { attendeeNameKey } from "@/lib/integrations/google/meeting-roster-names";
import {
    type AlmanacTerm,
    cleanTerm,
    MAX_ALMANAC_TERMS,
} from "./almanac-terms";

/** Ranks meeting names after the recorder, preserving the provider's term limits. */
export function mergeMeetingTerms(
    terms: readonly AlmanacTerm[],
    attendees: readonly MeetingAttendee[],
    recorderName: string | null,
    agendaTerms: readonly string[] = [],
): AlmanacTerm[] {
    const recorder = recorderName
        ? terms.find(
              (term) =>
                  attendeeNameKey(term.text) === attendeeNameKey(recorderName),
          )
        : undefined;
    const almanac = new Map(
        terms.map((term) => [attendeeNameKey(term.text), term]),
    );
    const ordered = [
        ...(recorder ? [recorder] : []),
        ...attendees.map(
            ({ name }) =>
                almanac.get(attendeeNameKey(name)) ?? {
                    text: name,
                    soundsLike: [],
                },
        ),
        ...terms,
        ...agendaTerms.slice(0, 50).map(
            (text) =>
                almanac.get(attendeeNameKey(text)) ?? {
                    text,
                    soundsLike: [],
                },
        ),
    ];
    const merged = new Map<string, AlmanacTerm>();
    for (const term of ordered) {
        const text = cleanTerm(term.text);
        if (!text) continue;
        const key = attendeeNameKey(text);
        const held = merged.get(key);
        if (held) {
            held.soundsLike = [
                ...new Set([...held.soundsLike, ...term.soundsLike]),
            ]
                .filter(
                    (form) =>
                        cleanTerm(form) !== null &&
                        attendeeNameKey(form) !== key,
                )
                .slice(0, 10);
        } else if (merged.size < MAX_ALMANAC_TERMS) {
            merged.set(key, { text, soundsLike: term.soundsLike.slice(0, 10) });
        }
    }
    return [...merged.values()];
}
