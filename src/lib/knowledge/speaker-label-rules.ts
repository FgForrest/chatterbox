/**
 * Which speaker labels a transcript has, and the one form they are stored and
 * compared in.
 *
 * Pure on purpose: no encryption and no environment, so the UI, the share
 * gate and the label matching can all import it and agree on exactly the
 * labels a person can name.
 */

import {
    mayBeDiarized,
    parseSpeakerTurns,
} from "@/lib/transcription/diarization";
import type { TranscriptTurn } from "@/lib/transcription/turns";

/** Longest stored label; matches `transcript_speakers.label`. */
export const MAX_SPEAKER_LABEL_LENGTH = 64;

/** Anything that carries a raw speaker label: provider turns or parsed ones. */
export interface LabelledTurn {
    speaker: string;
}

export interface SpeakerLabelSource {
    source?: string | null;
    model?: string | null;
    /** Decrypted transcript text. */
    text: string;
    /** Decrypted provider turns, when the transcript was stored with them. */
    turns?: readonly LabelledTurn[] | null;
}

/**
 * True for a label that names no one: an empty label, or the `speaker`
 * Speechmatics writes for speech it could not attribute.
 */
export function isPlaceholderSpeakerLabel(label: string): boolean {
    const normalized = label.trim().toLowerCase();
    return normalized === "" || normalized === "speaker";
}

/**
 * The stored form of a label, and the form every comparison uses. Providers
 * store turn labels as they come, padded or overlong; the key is what a
 * person names.
 */
export function speakerKey(label: string): string {
    return label.trim().slice(0, MAX_SPEAKER_LABEL_LENGTH);
}

/** Real labels in the order they first speak, as keys. */
export function labelsFromTurns(turns: readonly LabelledTurn[]): string[] {
    const labels: string[] = [];
    const seen = new Set<string>();
    for (const turn of turns) {
        if (isPlaceholderSpeakerLabel(turn.speaker)) continue;
        const key = speakerKey(turn.speaker);
        if (seen.has(key)) continue;
        seen.add(key);
        labels.push(key);
    }
    return labels;
}

/**
 * The speaker labels of one transcript: its stored turns when it has them,
 * otherwise `speaker: text` lines, parsed only from a transcript made by a
 * diarizing path. A prompt-based transcript that happens to contain `Name:`
 * lines has no speakers.
 */
export function speakerLabelsForTranscript({
    source,
    model,
    text,
    turns,
}: SpeakerLabelSource): string[] {
    if (turns?.length) return labelsFromTurns(turns);
    if (!mayBeDiarized({ source, model })) return [];
    const parsed = parseSpeakerTurns(text);
    return parsed ? labelsFromTurns(parsed) : [];
}

/** One version of a transcript, as far as its speakers go. */
export interface SpeakerVersion {
    /** Decrypted timed turns, or null for a transcript without timings. */
    turns: readonly TranscriptTurn[] | null;
    /** Its speaker labels as keys, first speaker first. */
    labels: readonly string[];
}

/** The speaker side of a decrypted transcript version. */
export function speakerVersionOf(input: {
    source?: string | null;
    model?: string | null;
    text: string;
    turns?: readonly TranscriptTurn[] | null;
}): SpeakerVersion {
    const turns = input.turns?.length ? input.turns : null;
    return { turns, labels: speakerLabelsForTranscript({ ...input, turns }) };
}
