import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { transcriptions } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { AppError } from "@/lib/errors";
import { buildNameResolver } from "@/lib/knowledge/attribution";
import { correctionOverlay } from "@/lib/learn/llm-input";
import { renderTurnsForPeople } from "@/lib/learn/render";
import type { McpCaller } from "@/lib/mcp/caller";
import { notFound } from "@/lib/mcp/errors";
import type { RecordingView } from "@/lib/sharing/view";
import {
    formatSpeakerLabel,
    parseSpeakerTurns,
} from "@/lib/transcription/diarization";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";
import {
    getPreferredTranscriptSource,
    resolvePrimaryTranscript,
} from "@/lib/v1/serialize";

/** One turn of a transcript as people read it. */
export interface ReadableTurn {
    /** The provider's speaker label (identity, not display); "" for none. */
    label: string;
    /** Milliseconds from the start of the audio; null when untimed. */
    startMs: number | null;
    endMs: number | null;
    text: string;
}

/** A recording's primary transcript, its confirmed corrections applied. */
export interface ReadableTranscript {
    id: string;
    /** The recording's owner, who owns the transcript and names its speakers. */
    ownerUserId: string;
    /** The view the caller reads it in. */
    view: RecordingView;
    language: string | null;
    /** Whether the turns carry timings (stored turns, not parsed text). */
    timed: boolean;
    turns: ReadableTurn[];
}

/** The recording a transcript is loaded for, already checked readable. */
export interface TranscriptRecording {
    id: string;
    ownerUserId: string;
    view: RecordingView;
}

/**
 * The transcript source a caller prefers: a user's own setting, the
 * Organization account's for a service caller.
 */
export function preferredSourceFor(caller: McpCaller): Promise<string> {
    return getPreferredTranscriptSource(
        caller.kind === "user" ? caller.userId : caller.orgUserId,
    );
}

function untimedTurns(text: string): ReadableTurn[] {
    const parsed = parseSpeakerTurns(text);
    if (parsed) {
        return parsed.map((turn) => ({
            label: turn.speaker,
            startMs: null,
            endMs: null,
            text: turn.text,
        }));
    }
    return text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => ({ label: "", startMs: null, endMs: null, text: line }));
}

/**
 * The primary transcript of a recording the caller reads (resolved by
 * `resolveRecording` or filtered by `mcpRecordingCondition`), as people
 * read it in the caller's view: the owner's transcript rows, the caller's
 * preferred source first, the confirmed corrections in effect (the
 * Organization's while the recording is shared, the owner's otherwise;
 * never those of a review not yet finished). A transcript without stored
 * turns is read from its text, untimed and uncorrected. Null when the
 * recording has no transcript; `McpToolError` "Not found" when an
 * Organization reader's recording stopped being shared meanwhile.
 */
export async function loadReadableTranscript(
    caller: McpCaller,
    recording: TranscriptRecording,
    options: { preferredSource?: string } = {},
): Promise<ReadableTranscript | null> {
    const rows = await db
        .select()
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recording.id),
                eq(transcriptions.userId, recording.ownerUserId),
            ),
        )
        .orderBy(asc(transcriptions.createdAt), asc(transcriptions.id));
    const primary = resolvePrimaryTranscript(
        rows,
        options.preferredSource ?? (await preferredSourceFor(caller)),
    );
    if (!primary) return null;
    const base = {
        id: primary.id,
        ownerUserId: recording.ownerUserId,
        view: recording.view,
        language: primary.detectedLanguage,
    };

    const stored = readTranscriptTurns(primary);
    if (!stored) {
        return {
            ...base,
            timed: false,
            turns: untimedTurns(decryptText(primary.text) ?? ""),
        };
    }
    let overlay: Awaited<ReturnType<typeof correctionOverlay>>;
    try {
        overlay = await correctionOverlay(
            {
                id: primary.id,
                userId: primary.userId,
                recordingId: recording.id,
                revision: primary.revision,
            },
            {
                pending: false,
                turns: stored,
                sharedAs: recording.view === "org" ? true : undefined,
            },
        );
    } catch (error) {
        if (error instanceof AppError && error.statusCode === 404) {
            throw notFound();
        }
        throw error;
    }
    return {
        ...base,
        timed: true,
        turns: renderTurnsForPeople(stored, overlay).map((turn) => ({
            label: turn.speaker,
            startMs: turn.startMs,
            endMs: turn.endMs,
            text: turn.text,
        })),
    };
}

/**
 * How a transcript's speakers read to the caller: confirmed names as the
 * owner gave them (Organization people only in the Organization view), any
 * other label in its generic form ("Speaker 1"); null for a turn without a
 * label.
 */
export async function speakerNamer(
    transcript: ReadableTranscript,
): Promise<(label: string) => string | null> {
    const resolve = await buildNameResolver(
        transcript.ownerUserId,
        transcript.id,
        { orgPeopleOnly: transcript.view === "org" },
    );
    return (label) => {
        if (!label.trim()) return null;
        return resolve?.(label) ?? (formatSpeakerLabel(label) || null);
    };
}
