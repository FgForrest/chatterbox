import type {
    TranscriptionCreateParamsNonStreaming,
    TranscriptionDiarized,
    TranscriptionVerbose,
} from "openai/resources/audio/transcriptions";
import {
    paragraphsFromTimedSegments,
    renderTurnsAsText,
    type TranscriptTurn,
    timedWordsInText,
    turnsFromLabelledSegments,
} from "@/lib/transcription/turns";

export type ResponseFormat = "diarized_json" | "json" | "verbose_json";

export function getResponseFormat(model: string): ResponseFormat {
    if (model.includes("diarize")) return "diarized_json";
    if (model.startsWith("gpt-4o")) return "json";
    return "verbose_json";
}

export interface ParsedTranscription {
    text: string;
    detectedLanguage: string | null;
    /**
     * Present only for a response that carried timed segments: diarized, or
     * verbose (speakerless paragraphs).
     */
    turns?: TranscriptTurn[];
}

export function parseTranscriptionResponse(
    transcription: unknown,
    responseFormat: ResponseFormat,
): ParsedTranscription {
    if (responseFormat === "diarized_json") {
        const diarized = transcription as TranscriptionDiarized;
        const segments = diarized.segments ?? [];
        const turns = turnsFromLabelledSegments(
            segments.map((seg) => ({
                speaker: seg.speaker,
                startMs: Math.round(seg.start * 1000),
                endMs: Math.round(seg.end * 1000),
                text: seg.text,
            })),
        );
        // Text is rendered from the turns so the flat transcript and the
        // structured turns are two views of one grouping and cannot drift.
        const text = turns
            ? renderTurnsAsText(turns)
            : segments.map((seg) => `${seg.speaker}: ${seg.text}`).join("\n");
        return {
            text,
            detectedLanguage: null,
            ...(turns ? { turns } : {}),
        };
    }

    if (responseFormat === "verbose_json") {
        const verbose = transcription as TranscriptionVerbose;
        // Kept as speakerless turns so the transcript carries timings: that
        // is what seeking and topics are anchored to. Some OpenAI-compatible
        // servers answer this format without segments; those keep the flat
        // text alone, as before.
        const words = (verbose.words ?? []).map((word) => ({
            text: word.word,
            startMs: Math.round(word.start * 1000),
            endMs: Math.round(word.end * 1000),
        }));
        let wordIndex = 0;
        const turns = paragraphsFromTimedSegments(
            (verbose.segments ?? []).map((seg) => {
                const startMs = Math.round(seg.start * 1000);
                const endMs = Math.round(seg.end * 1000);
                const segmentWords: typeof words = [];
                if (
                    Number.isFinite(startMs) &&
                    Number.isFinite(endMs) &&
                    endMs >= startMs
                ) {
                    while (wordIndex < words.length) {
                        const word = words[wordIndex];
                        if (
                            !Number.isFinite(word.startMs) ||
                            word.startMs < startMs
                        ) {
                            wordIndex++;
                            continue;
                        }
                        if (word.startMs >= endMs) break;
                        segmentWords.push(word);
                        wordIndex++;
                    }
                }
                return {
                    startMs,
                    endMs,
                    text: seg.text,
                    units: timedWordsInText(seg.text, segmentWords),
                };
            }),
        );
        return {
            text: turns ? renderTurnsAsText(turns) : verbose.text,
            detectedLanguage: verbose.language ?? null,
            ...(turns ? { turns } : {}),
        };
    }

    const plain = transcription as { text?: string };
    const text =
        typeof transcription === "string" ? transcription : (plain.text ?? "");
    return { text, detectedLanguage: null };
}

export function buildTranscriptionParams(args: {
    file: File;
    model: string;
    responseFormat: ResponseFormat;
    language?: string;
}): TranscriptionCreateParamsNonStreaming {
    const { file, model, responseFormat, language } = args;
    return {
        file,
        model,
        response_format: responseFormat,
        ...(responseFormat === "diarized_json"
            ? { chunking_strategy: "auto" as const }
            : {}),
        ...(language ? { language } : {}),
    };
}
