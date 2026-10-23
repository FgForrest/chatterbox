import { attendeeNameKey } from "@/lib/integrations/google/meeting-roster-names";
import type { KnowledgeView } from "@/lib/knowledge/knowledge-loader";
import type { LearnRunFrame } from "./validate";

/** Bounded Almanac context for speaker identification in either model path. */
export interface SpeakerPromptContext {
    knownPeople: {
        personId: string;
        name: string;
        aliases?: readonly string[];
    }[];
    answeredSpeakers: { label: string; personId: string | null }[];
    knownFacts: Pick<
        KnowledgeView["facts"][number],
        "subject" | "relationKey" | "object"
    >[];
}

/** Selects roster matches, the recorder and lookup results from the run's visible Almanac. */
export function speakerPromptContext(
    frame: Pick<
        LearnRunFrame,
        "people" | "answeredLabels" | "recorderPersonId" | "speakerCandidates"
    >,
    facts: readonly SpeakerPromptContext["knownFacts"][number][],
    lookupPersonIds: readonly string[] = [],
): SpeakerPromptContext {
    const rosterKeys = new Set(
        (frame.speakerCandidates ?? []).map(({ name }) =>
            attendeeNameKey(name),
        ),
    );
    const rosterIds = [...frame.people]
        .filter(([, person]) =>
            [person.name, ...(person.aliases ?? [])].some((name) =>
                rosterKeys.has(attendeeNameKey(name)),
            ),
        )
        .map(([id]) => id);
    const ids = [
        ...new Set([
            ...(frame.recorderPersonId ? [frame.recorderPersonId] : []),
            ...(frame.speakerCandidates ?? []).flatMap((attendee) =>
                attendee.personId ? [attendee.personId] : [],
            ),
            ...rosterIds,
            ...lookupPersonIds,
        ]),
    ]
        .filter((id) => frame.people.has(id))
        .slice(0, 100);
    const selected = new Set(ids);
    const perPerson = new Map<string, number>();
    const knownFacts: SpeakerPromptContext["knownFacts"] = [];
    for (const { subject, relationKey, object } of facts) {
        if (
            !("personId" in subject) ||
            !selected.has(subject.personId) ||
            !("literal" in object)
        )
            continue;
        const count = perPerson.get(subject.personId) ?? 0;
        if (count >= 3) continue;
        knownFacts.push({ subject, relationKey, object });
        perPerson.set(subject.personId, count + 1);
        if (knownFacts.length >= 150) break;
    }
    return {
        knownPeople: ids.flatMap((personId) => {
            const person = frame.people.get(personId);
            return person ? [{ personId, ...person }] : [];
        }),
        answeredSpeakers: [...frame.answeredLabels]
            .filter(([, id]) => id === null || frame.people.has(id))
            .map(([label, personId]) => ({ label, personId })),
        knownFacts,
    };
}
