import { and, eq, or } from "drizzle-orm";
import { db } from "@/db";
import {
    people,
    transcriptions,
    transcriptSpeakerRejections,
    transcriptSpeakers,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { orgOwnedCondition } from "@/lib/knowledge/org-people";
import {
    labelsFromTurns,
    speakerKey,
} from "@/lib/knowledge/speaker-label-rules";
import { speakerAnchorId } from "@/lib/knowledge/speaker-references";
import { parseSpeakerTurns } from "@/lib/transcription/diarization";
import type { SpeakerNameResolver } from "@/lib/transcription/turns";

export type AttributionSource =
    | "user"
    | "calendar"
    | "meet"
    | "llm"
    | "heuristic";

export type AttributionStatus = "confirmed" | "suggested" | "rejected";

/** One speaker label of one transcript, and who it refers to. */
export interface TranscriptSpeaker {
    id: string;
    label: string;
    personId: string | null;
    personName: string | null;
    source: AttributionSource;
    status: AttributionStatus;
    confidence: number | null;
    evidenceStartMs: number | null;
    /** A person looked and said nobody known: an answer, not an open label. */
    markedUnknown: boolean;
    /** The human who confirmed the row; null on machine rows. */
    confirmedByUserId: string | null;
}

export interface SetTranscriptSpeakerArgs {
    userId: string;
    transcriptionId: string;
    label: string;
    personId: string | null;
    source: AttributionSource;
    status: AttributionStatus;
    confidence?: number | null;
    evidenceStartMs?: number | null;
    markedUnknown?: boolean;
    confirmedByUserId?: string | null;
}

/** One speaker label of one transcript. */
export interface TranscriptLabelArgs {
    userId: string;
    transcriptionId: string;
    label: string;
}

/** A suggestion a machine made, before it is filtered and written. */
export interface SuggestedSpeaker {
    label: string;
    personId: string | null;
    source: AttributionSource;
    confidence?: number | null;
    evidenceStartMs?: number | null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface NameScopeOptions {
    /**
     * Name speakers with Organization people only. Set whenever the text is
     * read through the Organization view: it may be showing the owner's
     * transcript, whose attributions can still point at the owner's private
     * people, and those names are the owner's alone.
     */
    orgPeopleOnly?: boolean;
}

function namePeopleCondition(ownerId: string, options: NameScopeOptions) {
    return options.orgPeopleOnly
        ? orgOwnedCondition(people.userId)
        : or(eq(people.userId, ownerId), orgOwnedCondition(people.userId));
}

interface TransferableSpeakerRow {
    transcriptionId: string;
    transcriptionSource: string;
    transcriptionText: string;
    label: string | null;
    personId: string | null;
    source: AttributionSource | null;
    confidence: number | null;
    evidenceStartMs: number | null;
}

interface CopyMatchingSpeakerAttributionsArgs {
    userId: string;
    recordingId: string;
    sourceSource: string;
    targetSource: string;
    targetText: string;
}

function orderedSpeakers(text: string): string[] {
    return labelsFromTurns(parseSpeakerTurns(text) ?? []);
}

function remapCandidateRows(
    rows: readonly TransferableSpeakerRow[],
    nextSpeakers: readonly string[],
): Omit<SetTranscriptSpeakerArgs, "userId" | "transcriptionId">[] {
    const previousSpeakers = orderedSpeakers(
        decryptText(rows[0]?.transcriptionText ?? ""),
    );
    if (
        previousSpeakers.length === 0 ||
        previousSpeakers.length !== nextSpeakers.length
    ) {
        return [];
    }

    return rows.flatMap((row) => {
        if (!row.label || !row.personId || !row.source) return [];
        const previousIndex = previousSpeakers.findIndex(
            (label) =>
                speakerAnchorId(label) === speakerAnchorId(row.label ?? ""),
        );
        if (previousIndex === -1) return [];
        return [
            {
                label: nextSpeakers[previousIndex],
                personId: row.personId,
                source: row.source,
                status: "confirmed" as const,
                confidence: row.confidence,
                evidenceStartMs: row.evidenceStartMs,
            },
        ];
    });
}

/**
 * Copy confirmed names from another transcript source after the first manual
 * Riffado transcription, provided both diarizations found the same number of
 * speakers. Labels are mapped by speaker order so `Speaker 0` and `speaker_0`
 * remain equivalent across providers.
 */
export async function copyMatchingSpeakerAttributions({
    userId,
    recordingId,
    sourceSource,
    targetSource,
    targetText,
}: CopyMatchingSpeakerAttributionsArgs): Promise<boolean> {
    const rows = await db
        .select({
            transcriptionId: transcriptions.id,
            transcriptionSource: transcriptions.source,
            transcriptionText: transcriptions.text,
            label: transcriptSpeakers.label,
            personId: transcriptSpeakers.personId,
            source: transcriptSpeakers.source,
            confidence: transcriptSpeakers.confidence,
            evidenceStartMs: transcriptSpeakers.evidenceStartMs,
        })
        .from(transcriptions)
        .leftJoin(
            transcriptSpeakers,
            and(
                eq(transcriptSpeakers.transcriptionId, transcriptions.id),
                eq(transcriptSpeakers.userId, userId),
                eq(transcriptSpeakers.status, "confirmed"),
            ),
        )
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, userId),
            ),
        );

    const target = rows.find((row) => row.transcriptionSource === targetSource);
    const nextSpeakers = orderedSpeakers(targetText);
    if (!target || nextSpeakers.length === 0) return false;

    const candidates = new Map<string, TransferableSpeakerRow[]>();
    for (const row of rows) {
        if (
            row.transcriptionId === target.transcriptionId ||
            row.transcriptionSource !== sourceSource ||
            !row.personId
        ) {
            continue;
        }
        const candidate = candidates.get(row.transcriptionId) ?? [];
        candidate.push(row);
        candidates.set(row.transcriptionId, candidate);
    }

    const mapped = Array.from(candidates.values())
        .map((candidate) => remapCandidateRows(candidate, nextSpeakers))
        .filter((candidate) => candidate.length > 0)
        .sort((left, right) => right.length - left.length)[0];
    if (!mapped) return false;

    await db
        .insert(transcriptSpeakers)
        .values(
            mapped.map((row) => ({
                ...row,
                userId,
                transcriptionId: target.transcriptionId,
            })),
        )
        .onConflictDoNothing();
    return true;
}

/**
 * Every attribution for one transcript, resolved names included.
 *
 * `ownerId` is the user the transcript belongs to, not necessarily the user
 * asking: a speaker is named by the owner, so a reader of a shared transcript
 * must see the owner's naming rather than their own. It also bounds the join
 * to `people` -- the owner's own, or the Organization's, which everyone
 * shares -- so a stored `personId` can never reach another account's.
 */
export async function getTranscriptSpeakers(
    ownerId: string,
    transcriptionId: string,
    options: NameScopeOptions = {},
): Promise<TranscriptSpeaker[]> {
    const rows = await db
        .select({
            id: transcriptSpeakers.id,
            label: transcriptSpeakers.label,
            personId: transcriptSpeakers.personId,
            personName: people.displayName,
            source: transcriptSpeakers.source,
            status: transcriptSpeakers.status,
            confidence: transcriptSpeakers.confidence,
            evidenceStartMs: transcriptSpeakers.evidenceStartMs,
            markedUnknown: transcriptSpeakers.markedUnknown,
            confirmedByUserId: transcriptSpeakers.confirmedByUserId,
        })
        .from(transcriptSpeakers)
        .leftJoin(
            people,
            and(
                eq(people.id, transcriptSpeakers.personId),
                namePeopleCondition(ownerId, options),
            ),
        )
        .where(
            and(
                eq(transcriptSpeakers.userId, ownerId),
                eq(transcriptSpeakers.transcriptionId, transcriptionId),
            ),
        );

    return rows.map((row) => ({
        ...row,
        personName: row.personName ? decryptText(row.personName) : null,
    }));
}

/**
 * Record who a speaker label refers to, replacing any previous answer for
 * that label.
 *
 * A correction is an ordinary update with nothing downstream to repair,
 * which is the whole benefit of attributing by name rather than by
 * voiceprint: there is no profile to poison, only a label to change.
 *
 * Naming a person a human once rejected for this label takes the rejection
 * back: the latest answer is the one that counts.
 */
export async function setTranscriptSpeaker(
    args: SetTranscriptSpeakerArgs,
): Promise<void> {
    await db.transaction((tx) => setTranscriptSpeakerInTx(tx, args));
}

async function setTranscriptSpeakerInTx(
    tx: Tx,
    {
        userId,
        transcriptionId,
        label,
        personId,
        source,
        status,
        confidence = null,
        evidenceStartMs = null,
        markedUnknown = false,
        confirmedByUserId = null,
    }: SetTranscriptSpeakerArgs,
): Promise<void> {
    await tx
        .insert(transcriptSpeakers)
        .values({
            userId,
            transcriptionId,
            label,
            personId,
            source,
            status,
            confidence,
            evidenceStartMs,
            markedUnknown,
            confirmedByUserId,
        })
        .onConflictDoUpdate({
            target: [
                transcriptSpeakers.transcriptionId,
                transcriptSpeakers.label,
            ],
            set: {
                personId,
                source,
                status,
                confidence,
                evidenceStartMs,
                markedUnknown,
                confirmedByUserId,
                updatedAt: new Date(),
            },
        });
    if (personId && status === "confirmed") {
        await tx
            .delete(transcriptSpeakerRejections)
            .where(
                and(
                    eq(
                        transcriptSpeakerRejections.transcriptionId,
                        transcriptionId,
                    ),
                    eq(transcriptSpeakerRejections.label, label),
                    eq(transcriptSpeakerRejections.personId, personId),
                ),
            );
    }
}

/** Return a label to open: no name, no suggestion, no "unknown". */
export async function clearTranscriptSpeaker(
    args: TranscriptLabelArgs,
): Promise<void> {
    await db.transaction((tx) => clearTranscriptSpeakerInTx(tx, args));
}

async function clearTranscriptSpeakerInTx(
    tx: Tx,
    { userId, transcriptionId, label }: TranscriptLabelArgs,
): Promise<void> {
    await tx
        .delete(transcriptSpeakers)
        .where(
            and(
                eq(transcriptSpeakers.userId, userId),
                eq(transcriptSpeakers.transcriptionId, transcriptionId),
                eq(transcriptSpeakers.label, label),
            ),
        );
}

/**
 * Say a suggested person is not this speaker. The pair is remembered, so
 * the same suggestion is never offered again for this label, even after
 * other suggestions came and went.
 */
export async function rejectSuggestion(
    args: TranscriptLabelArgs & { personId: string },
): Promise<void> {
    await db.transaction((tx) => rejectSuggestionInTx(tx, args));
}

async function rejectSuggestionInTx(
    tx: Tx,
    {
        userId,
        transcriptionId,
        label,
        personId,
    }: TranscriptLabelArgs & { personId: string },
): Promise<void> {
    await tx
        .insert(transcriptSpeakerRejections)
        .values({ userId, transcriptionId, label, personId })
        .onConflictDoNothing();
    await tx
        .delete(transcriptSpeakers)
        .where(
            and(
                eq(transcriptSpeakers.userId, userId),
                eq(transcriptSpeakers.transcriptionId, transcriptionId),
                eq(transcriptSpeakers.label, label),
                eq(transcriptSpeakers.personId, personId),
                eq(transcriptSpeakers.status, "suggested"),
            ),
        );
}

/**
 * Write machine suggestions for one transcript.
 *
 * A suggestion never overwrites anything: a label that already has a row,
 * whether a human's answer or an earlier suggestion, keeps it. A suggestion
 * without a person has nothing to offer, and a pair a human rejected stays
 * rejected. Returns how many were written.
 */
export async function insertSuggestionsInTx(
    tx: Tx,
    {
        userId,
        transcriptionId,
        rows,
    }: {
        userId: string;
        transcriptionId: string;
        rows: readonly SuggestedSpeaker[];
    },
): Promise<number> {
    const named = rows.flatMap((row) =>
        row.personId
            ? [{ ...row, label: speakerKey(row.label), personId: row.personId }]
            : [],
    );
    if (named.length === 0) return 0;
    const rejected = await tx
        .select({
            label: transcriptSpeakerRejections.label,
            personId: transcriptSpeakerRejections.personId,
        })
        .from(transcriptSpeakerRejections)
        .where(
            eq(transcriptSpeakerRejections.transcriptionId, transcriptionId),
        );
    const rejectedPairs = new Set(
        rejected.map((row) => pairKey(row.label, row.personId)),
    );
    const allowed = named.filter(
        (row) => !rejectedPairs.has(pairKey(row.label, row.personId)),
    );
    if (allowed.length === 0) return 0;
    const inserted = await tx
        .insert(transcriptSpeakers)
        .values(
            allowed.map((row) => ({
                userId,
                transcriptionId,
                label: row.label,
                personId: row.personId,
                source: row.source,
                status: "suggested" as const,
                confidence: row.confidence ?? null,
                evidenceStartMs: row.evidenceStartMs ?? null,
            })),
        )
        .onConflictDoNothing()
        .returning({ id: transcriptSpeakers.id });
    return inserted.length;
}

function pairKey(label: string, personId: string): string {
    return `${label}\u0000${personId}`;
}

/**
 * Build the function that turns a raw speaker label into a display name.
 *
 * **Confirmed attributions only.** A suggested attribution renders in the UI
 * as a suggestion and never reaches transcript text, a summary prompt, an
 * export or the API: a machine guess that silently became the name on a
 * meeting minute is the failure this feature most needs to avoid, and
 * refusing to project it is what prevents that.
 *
 * Returns `undefined` when nobody is named, so `projectTranscript` serves the
 * stored text verbatim rather than re-rendering it from the turns for no gain.
 *
 * `ownerId` is the user the transcript belongs to, not necessarily the user
 * asking: a speaker is named by the owner, so a reader of a shared transcript
 * must see the owner's naming rather than their own. It also bounds the join
 * to `people`, so a stored `personId` can never reach across a tenant.
 */
export async function buildNameResolver(
    ownerId: string,
    transcriptionId: string,
    options: NameScopeOptions = {},
): Promise<SpeakerNameResolver | undefined> {
    const rows = await db
        .select({
            label: transcriptSpeakers.label,
            displayName: people.displayName,
        })
        .from(transcriptSpeakers)
        .innerJoin(
            people,
            and(
                eq(people.id, transcriptSpeakers.personId),
                namePeopleCondition(ownerId, options),
            ),
        )
        .where(
            and(
                eq(transcriptSpeakers.userId, ownerId),
                eq(transcriptSpeakers.transcriptionId, transcriptionId),
                eq(transcriptSpeakers.status, "confirmed"),
            ),
        );

    return rows.length > 0 ? namesFromRows(rows) : undefined;
}

/**
 * The resolver itself, separated from the query so the projection rule is
 * testable without a database.
 */
export function namesFromRows(
    rows: readonly { label: string; displayName: string }[],
): SpeakerNameResolver {
    const names = new Map(
        rows.map((row) => [
            speakerKey(row.label),
            decryptText(row.displayName),
        ]),
    );
    return (speaker: string) => names.get(speakerKey(speaker)) ?? null;
}

/** A resolver that names nobody, for transcripts with no attributions. */
export function emptyNameResolver(): SpeakerNameResolver {
    return () => null;
}
