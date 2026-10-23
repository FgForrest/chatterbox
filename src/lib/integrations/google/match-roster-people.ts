import { findPersonByEmail } from "@/lib/knowledge/people";
import type { MeetingAttendee } from "./meeting-roster";
import { attendeeNameKey } from "./meeting-roster-names";

/** Run-local Google data; addresses must be stripped before leaving the matcher. */
export interface RosterAttendeeInput {
    name: string;
    source: "calendar" | "meet";
    invited?: boolean;
    emails?: readonly string[];
}

/** Links attendees through the existing hash lookup, returning only names and provenance. */
export async function matchRosterPeople(input: {
    ownerUserId: string;
    scopeUserId: string;
    people: ReadonlyMap<string, { name: string; aliases?: readonly string[] }>;
    attendees: readonly RosterAttendeeInput[];
}): Promise<{
    attendees: MeetingAttendee[];
    dropped: Partial<Record<"ambiguousName" | "conflicting", number>>;
}> {
    const attendees: MeetingAttendee[] = [];
    const dropped: Partial<Record<"ambiguousName" | "conflicting", number>> =
        {};
    const personIds = [...input.people.keys()];
    for (const attendee of input.attendees) {
        const safe: MeetingAttendee = {
            name: attendee.name,
            source: attendee.source,
            ...(attendee.invited ? { invited: true } : {}),
        };
        const matches = new Set<string>();
        let ambiguous = false;
        for (const email of new Set(attendee.emails ?? [])) {
            const person = await findPersonByEmail(input.ownerUserId, email, {
                scopeUserId: input.scopeUserId,
                personIds,
                onAmbiguous: () => {
                    ambiguous = true;
                },
            });
            if (person && input.people.has(person.id)) matches.add(person.id);
        }
        const nameMatches = [...input.people].filter(([, person]) =>
            [person.name, ...(person.aliases ?? [])].some(
                (name) =>
                    attendeeNameKey(name) === attendeeNameKey(attendee.name),
            ),
        );
        const personId = [...matches][0];
        if (ambiguous || matches.size > 1) {
            dropped.ambiguousName = (dropped.ambiguousName ?? 0) + 1;
        } else if (personId && nameMatches.some(([id]) => id !== personId)) {
            dropped.conflicting = (dropped.conflicting ?? 0) + 1;
        } else if (personId) {
            const person = input.people.get(personId);
            if (person) {
                safe.name = person.name;
                safe.personId = personId;
                safe.matchedByEmail = true;
            }
        }
        if (
            !safe.matchedByEmail &&
            attendee.emails?.some((email) =>
                safe.name.toLowerCase().includes(email.trim().toLowerCase()),
            )
        )
            safe.name = "";
        if (safe.name) attendees.push(safe);
    }
    return { attendees, dropped };
}
