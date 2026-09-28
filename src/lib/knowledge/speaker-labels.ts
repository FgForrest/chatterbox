import { decryptText } from "@/lib/encryption/fields";
import { speakerLabelsForTranscript } from "@/lib/knowledge/speaker-label-rules";
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
    return speakerLabelsForTranscript({
        source: row.source,
        model: row.model,
        text: decryptText(row.text),
        turns: readTranscriptTurns(row),
    });
}
