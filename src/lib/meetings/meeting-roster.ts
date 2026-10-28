import { matchRosterPeople } from "@/lib/integrations/google/match-roster-people";
import { listPeople } from "@/lib/knowledge/people";
import { getOrgUserId } from "@/lib/org/config";

/** Resolve unnamed invitees against only the viewer's visible Almanac; never return addresses. */
export async function meetingInvitees(
    userId: string,
    attendees: readonly { name: string; email?: string }[],
) {
    const safeName = (name: string) =>
        /[^\s@]+@[^\s@]+/.test(name) ? "" : name.trim();
    const people = attendees.some(
        (attendee) => !safeName(attendee.name) && attendee.email,
    )
        ? await listPeople(userId)
        : [];
    const orgUserId = people.some((person) => person.scope === "org")
        ? await getOrgUserId()
        : null;
    const scopes = [...new Set([userId, ...(orgUserId ? [orgUserId] : [])])];
    return Promise.all(
        attendees.map(async (attendee) => {
            const name = safeName(attendee.name);
            const email = attendee.email;
            if (name || !email) return { name };
            const matches = await Promise.all(
                scopes.map((scopeUserId) =>
                    matchRosterPeople({
                        ownerUserId: userId,
                        scopeUserId,
                        people: new Map(
                            people
                                .filter(
                                    (person) =>
                                        (person.scope === "org"
                                            ? orgUserId
                                            : userId) === scopeUserId,
                                )
                                .map((person) => [
                                    person.id,
                                    { name: person.displayName },
                                ]),
                        ),
                        attendees: [
                            {
                                name: "",
                                source: "calendar",
                                emails: [email],
                            },
                        ],
                    }),
                ),
            );
            const named = matches.flatMap((match) => match.attendees);
            const ambiguous = matches.some(
                (match) =>
                    match.dropped.ambiguousName || match.dropped.conflicting,
            );
            return {
                name:
                    !ambiguous && named.length === 1
                        ? safeName(named[0].name)
                        : "",
            };
        }),
    );
}
