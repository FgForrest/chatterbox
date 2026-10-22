import { attendeeNameKey } from "@/lib/integrations/google/meeting-roster-names";
import type { LearnOutput } from "./output";
import type { DropReason, LearnRunFrame, ReviewCandidate } from "./validate";
import { newRecordFingerprint } from "./validate-new-records";

/** Adds bounded, unticked speaker guesses after evidence-backed proposals. */
export function appendSpeakerGuesses(
    output: LearnOutput,
    frame: LearnRunFrame,
    items: ReviewCandidate[],
    checks: {
        dismissed: (fingerprint: string) => boolean;
        drop: (reason: DropReason) => void;
    },
): void {
    const labels = new Set(frame.turns.map((turn) => turn.speaker));
    const assignedLabels = new Set(frame.answeredLabels.keys());
    const assignedPeople = new Set(
        [...frame.answeredLabels.values()].filter((id) => id !== null),
    );
    const assignedNames = new Set<string>();
    for (const item of items) {
        if (item.kind !== "speaker") continue;
        const personId = item.payload.personId;
        const record = items.find(
            (candidate) =>
                candidate.kind === "new_record" &&
                candidate.payload.ref === item.payload.newRef,
        );
        const name = personId
            ? frame.people.get(personId)?.name
            : record?.kind === "new_record"
              ? record.payload.name
              : undefined;
        if (name) {
            assignedNames.add(attendeeNameKey(name));
        }
        if (personId || item.payload.newRef)
            assignedLabels.add(item.payload.label);
        if (personId) assignedPeople.add(personId);
    }
    for (const personId of assignedPeople) {
        const name = frame.people.get(personId)?.name;
        if (name) assignedNames.add(attendeeNameKey(name));
    }
    const guesses = output.speakers
        .filter((speaker) => speaker.guess)
        .sort(
            (a, b) => (b.guess?.confidence ?? 0) - (a.guess?.confidence ?? 0),
        );
    for (const speaker of guesses) {
        const metadata = speaker.guess;
        if (!metadata) continue;
        if (!speaker.reason.trim()) {
            checks.drop("doesNotFit");
            continue;
        }
        if (!labels.has(speaker.label)) {
            checks.drop("unknownLabel");
            continue;
        }
        if (assignedLabels.has(speaker.label)) {
            checks.drop("answered");
            continue;
        }
        const attendee = frame.speakerCandidates?.find(
            (one) => one.name === speaker.rosterName,
        );
        const person = speaker.personId
            ? frame.people.get(speaker.personId)
            : undefined;
        if (speaker.personId ? !person : !attendee) {
            checks.drop("outOfScope");
            continue;
        }
        if (
            person &&
            speaker.rosterName &&
            (!attendee ||
                ![person.name, ...(person.aliases ?? [])].some(
                    (name) =>
                        attendeeNameKey(name) ===
                        attendeeNameKey(attendee.name),
                ))
        ) {
            checks.drop("conflicting");
            continue;
        }
        const name = person?.name ?? attendee?.name;
        if (!name) continue;
        const matches = [...frame.people].filter(([, known]) =>
            [known.name, ...(known.aliases ?? [])].some(
                (alias) => attendeeNameKey(alias) === attendeeNameKey(name),
            ),
        );
        if (!speaker.personId && matches.length > 1) {
            checks.drop("ambiguousName");
            continue;
        }
        const personId = speaker.personId ?? matches[0]?.[0] ?? null;
        const nameKey = attendeeNameKey(name);
        if (
            personId &&
            frame.rejectedSpeakers?.some(
                (rejected) =>
                    rejected.label === speaker.label &&
                    rejected.personId === personId,
            )
        ) {
            checks.drop("dismissed");
            continue;
        }
        if (
            (personId && assignedPeople.has(personId)) ||
            (!personId && assignedNames.has(nameKey))
        ) {
            checks.drop("conflicting");
            continue;
        }
        const fingerprint = JSON.stringify([
            "speaker",
            frame.transcriptKey ?? "",
            speaker.label,
            personId ?? nameKey,
        ]);
        if (checks.dismissed(fingerprint)) continue;
        const rosterMatches = (frame.speakerCandidates ?? []).filter((one) =>
            [name, ...(person?.aliases ?? [])].some(
                (alias) => attendeeNameKey(one.name) === attendeeNameKey(alias),
            ),
        );
        const source =
            (
                attendee ??
                rosterMatches.find((one) => one.source === "meet") ??
                rosterMatches[0]
            )?.source ?? "transcript";
        const metadataForRoster = {
            ...metadata,
            confidence: Math.min(0.49, metadata.confidence),
            clues: metadata.clues.filter((clue) => {
                if (clue === "meet") {
                    return rosterMatches.some((one) => one.source === "meet");
                }
                if (clue === "calendar") {
                    return rosterMatches.some(
                        (one) => one.source === "calendar" || one.invited,
                    );
                }
                return true;
            }),
        };
        let newRef: string | undefined;
        if (!personId) {
            const existing = items.find(
                (item) =>
                    item.kind === "new_record" &&
                    item.payload.kind === "person" &&
                    attendeeNameKey(item.payload.name) === nameKey,
            );
            if (existing?.kind === "new_record") newRef = existing.payload.ref;
            else {
                const recordFingerprint = newRecordFingerprint(
                    "person",
                    null,
                    name,
                );
                if (checks.dismissed(recordFingerprint)) continue;
                newRef = `roster:${speaker.label}`;
                items.push({
                    kind: "new_record",
                    fingerprint: recordFingerprint,
                    preTicked: false,
                    payload: {
                        ref: newRef,
                        kind: "person",
                        typeKey: null,
                        name,
                        evidenceMs: [],
                        reason: speaker.reason,
                        speakerLabel: speaker.label,
                        source,
                        guess: metadataForRoster,
                    },
                });
            }
        }
        const unresolved = items.find(
            (item) =>
                item.kind === "speaker" &&
                item.payload.label === speaker.label &&
                !item.payload.personId &&
                !item.payload.newRef,
        );
        if (unresolved) items.splice(items.indexOf(unresolved), 1);
        items.push({
            kind: "speaker",
            fingerprint,
            preTicked: false,
            payload: {
                label: speaker.label,
                personId,
                ...(newRef ? { newRef } : {}),
                evidenceMs: [],
                reason: speaker.reason,
                source,
                guess: metadataForRoster,
            },
        });
        assignedLabels.add(speaker.label);
        assignedNames.add(nameKey);
        if (personId) assignedPeople.add(personId);
    }
}
