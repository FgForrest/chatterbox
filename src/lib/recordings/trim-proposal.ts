import { z } from "zod";
import { anchorMatches } from "@/lib/knowledge/correction-anchors";
import { type OverlayCorrection, renderTurnsForLlm } from "@/lib/learn/render";
import type { PhaseRecord } from "@/lib/pipeline/types";
import {
    type CutRange,
    cutTranscript,
    snapCutEdge,
    validCutRange,
} from "@/lib/recordings/cut-range";
import { sentenceStarts } from "@/lib/topics/timeline";
import type { TranscriptTurn } from "@/lib/transcription/turns";

export const TRIM_PROMPT_VERSION = 1;
export const TRIM_WAIT_MS = 4 * 60 * 60 * 1000;
export const TRIM_INPUT_BYTES = 512 * 1024;
const time = z.number().int().nonnegative().safe();
const reason = z.string().trim().min(1).max(240);
const trimOutputSchema = z
    .object({
        start: z
            .object({
                firstKeptSentenceId: z.string().min(1),
                startMs: time,
                reason,
            })
            .strict()
            .nullable(),
        end: z
            .object({
                firstRemovedSentenceId: z.string().min(1),
                startMs: time,
                reason,
            })
            .strict()
            .nullable(),
    })
    .strict();
export type TrimEdges = z.infer<typeof trimOutputSchema>;
interface TrimAnchor {
    id: string;
    startMs: number;
    text: string;
    speaker: string;
}
export interface StoredTrimProposal extends TrimEdges {
    schemaVersion: 1;
    id: string;
    promptVersion: number;
    createdAt: string;
    deadline: string;
    transcript: { id: string; source: string; revision: number };
    inputFingerprint: string;
    renderingDigest?: string;
    revisions: { id: string; revision: number }[];
    audio: { fileMd5: string; duration: number; cutAt: string | null };
    profileRevisionId: string;
    provider: {
        credentialId: string;
        provider: string;
        model: string;
        payerUserId: string;
    };
}

/** Compare the audio and complete transcript revision audit with a proposal. */
export function trimAuditMatches(
    recording: { fileMd5: string; duration: number; cutAt: Date | null },
    revisions: readonly { id: string; revision: number }[],
    proposal: Pick<StoredTrimProposal, "audio" | "revisions">,
): boolean {
    return (
        recording.fileMd5 === proposal.audio.fileMd5 &&
        recording.duration === proposal.audio.duration &&
        (recording.cutAt?.toISOString() ?? null) === proposal.audio.cutAt &&
        revisions.length === proposal.revisions.length &&
        revisions.every((revision) =>
            proposal.revisions.some(
                (expected) =>
                    expected.id === revision.id &&
                    expected.revision === revision.revision,
            ),
        )
    );
}

/** Render the whole corrected transcript using raw, indivisible sentence anchors. */
export function trimAnchors(
    turns: readonly TranscriptTurn[],
    corrections: readonly OverlayCorrection[] = [],
): TrimAnchor[] {
    return turns.flatMap((turn, turnIndex) => {
        const overlay = corrections.filter(
            (c) => c.turnIndex === turnIndex && anchorMatches(c, turns),
        );
        const starts = sentenceStarts(turn).filter(
            ({ at }) =>
                !overlay.some((c) => c.charStart < at && c.charEnd > at),
        );
        return starts.map((start, index) => {
            const end = starts[index + 1]?.at ?? turn.text.length;
            const piece = { ...turn, text: turn.text.slice(start.at, end) };
            const local = overlay
                .filter((c) => c.charStart >= start.at && c.charEnd <= end)
                .map((c) => ({
                    ...c,
                    turnIndex: 0,
                    charStart: c.charStart - start.at,
                    charEnd: c.charEnd - start.at,
                }));
            return {
                id: `t${turnIndex}s${start.at}`,
                startMs: start.ms,
                speaker: turn.speaker,
                text: renderTurnsForLlm([piece], local)[0].text,
            };
        });
    });
}

/** Validate both proposed edges against exact anchors and every stored transcript. */
export function validateTrimOutput(
    raw: unknown,
    anchors: readonly TrimAnchor[],
    turns: readonly TranscriptTurn[],
    allTurns: readonly (readonly TranscriptTurn[])[],
    duration: number,
): TrimEdges {
    const output = trimOutputSchema.parse(raw);
    for (const [edge, value] of [
        ["start", output.start],
        ["end", output.end],
    ] as const) {
        if (!value) continue;
        const id =
            "firstKeptSentenceId" in value
                ? value.firstKeptSentenceId
                : value.firstRemovedSentenceId;
        const anchor = anchors.find((a) => a.id === id);
        if (
            !anchor ||
            anchor.startMs !== value.startMs ||
            snapCutEdge(turns, value.startMs, edge, duration) !== value.startMs
        )
            throw new Error("invalid_output");
        for (const turn of turns) {
            const starts = sentenceStarts(turn);
            if (
                starts.some(
                    (start, i) =>
                        start.ms < value.startMs &&
                        (starts[i + 1]?.ms ?? turn.endMs) > value.startMs,
                )
            )
                throw new Error("unsafe_overlap");
        }
    }
    if (output.start?.startMs === 0) output.start = null;
    if (output.end?.startMs === duration) output.end = null;
    if (!output.start && !output.end) return output;
    const range = trimRange(output, duration);
    if (
        !validCutRange(range, duration) ||
        !allTurns.length ||
        allTurns.some(
            (transcript) =>
                !transcript.length ||
                transcript.some((turn) => !(turn.endMs > turn.startMs)) ||
                !cutTranscript(transcript, range).text.trim(),
        )
    )
        throw new Error("invalid_output");
    return output;
}

/** Compute one retained interval; an unchecked edge remains in the recording. */
export function trimRange(
    edges: TrimEdges,
    duration: number,
    selected = { start: true, end: true },
): CutRange {
    return {
        startMs: selected.start ? (edges.start?.startMs ?? 0) : 0,
        endMs: selected.end ? (edges.end?.startMs ?? duration) : duration,
    };
}

/** Whether the private decision or its short inference still holds automatic work. */
export function trimHolds(phase: PhaseRecord | undefined): boolean {
    return (
        phase?.state === "outdated" ||
        phase?.state === "running" ||
        phase?.state === "pending" ||
        (phase?.state === "waiting" && phase.waitingFor?.kind === "trimReview")
    );
}
