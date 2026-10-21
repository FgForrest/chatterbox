import { speakerKey } from "@/lib/knowledge/speaker-label-rules";
import {
    resolveSpeakerAttribution,
    type SpeakerAttributions,
} from "@/lib/knowledge/speaker-references";

export interface SpeakerGroup {
    labels: string[];
    position: number;
}

/** Group confirmed identities in speaking order, leaving unanswered voices separate. */
export function speakerGroups(
    order: readonly string[],
    attributions: SpeakerAttributions,
): SpeakerGroup[] {
    const groups: SpeakerGroup[] = [];
    const byPerson = new Map<string, SpeakerGroup>();
    order.forEach((label, position) => {
        const personId = resolveSpeakerAttribution(
            attributions,
            label,
        )?.personId;
        const existing = personId ? byPerson.get(personId) : undefined;
        if (existing) existing.labels.push(label);
        else {
            const group = { labels: [label], position };
            groups.push(group);
            if (personId) byPerson.set(personId, group);
        }
    });
    return groups;
}

/** The earliest confirmed voice's colour position for every equivalent label. */
export function speakerPositions(
    order: readonly string[],
    attributions: SpeakerAttributions,
): ReadonlyMap<string, number> {
    return new Map(
        speakerGroups(order, attributions).flatMap((group) =>
            group.labels.map(
                (label) => [speakerKey(label), group.position] as const,
            ),
        ),
    );
}
