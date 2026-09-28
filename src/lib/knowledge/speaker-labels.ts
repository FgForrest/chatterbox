import { decryptText } from "@/lib/encryption/fields";
import {
    type SpeakerVersion,
    speakerVersionOf,
} from "@/lib/knowledge/speaker-label-rules";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";

/** The columns of a stored transcript that decide its speaker labels. */
export interface SpeakerLabelRow {
    source: string | null;
    model: string | null;
    /** Encrypted, as stored. */
    text: string;
    /** Encrypted, as stored. */
    turns?: unknown;
}

/** The speaker labels a person can name on a stored transcript, as keys. */
export function transcriptSpeakerLabels(row: SpeakerLabelRow): string[] {
    return [...storedSpeakerVersion(row).labels];
}

/** The speaker side of a stored transcript, before it is overwritten. */
export function storedSpeakerVersion(row: SpeakerLabelRow): SpeakerVersion {
    return speakerVersionOf({
        source: row.source,
        model: row.model,
        text: decryptText(row.text),
        turns: readTranscriptTurns(row),
    });
}
