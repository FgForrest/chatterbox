import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { people, transcriptions, transcriptSpeakers } from "@/db/schema";
import { namesFromRows } from "@/lib/knowledge/attribution";
import {
    orgOwnedCondition,
    visibleOwnerCondition,
} from "@/lib/knowledge/org-people";
import {
    type OverlayCorrection,
    renderTurnsForPeople,
} from "@/lib/learn/render";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";
import {
    renderTurnsAsText,
    type SpeakerNameResolver,
} from "@/lib/transcription/turns";

/** The columns any caller must already have to project a transcript. */
export interface ProjectableTranscript {
    id: string;
    /** Plaintext. Callers decrypt before projecting; this never touches keys. */
    text: string;
    turns?: unknown;
}

/**
 * Apply speaker names to a transcript without rewriting what is stored.
 *
 * Falls back to the plain text whenever there is nothing to apply -- no
 * stored turns, or no confirmed attribution -- so a transcript that predates
 * this feature reads exactly as it always did.
 */
export function projectTranscript(
    transcript: ProjectableTranscript,
    resolve: SpeakerNameResolver | undefined,
    /** Confirmed corrections, applied as people read them. */
    corrections: readonly OverlayCorrection[] = [],
): string {
    if (!resolve && corrections.length === 0) return transcript.text;
    const stored = readTranscriptTurns(transcript);
    if (!stored) return transcript.text;
    const turns =
        corrections.length > 0
            ? renderTurnsForPeople(stored, corrections)
            : stored;
    const changed = turns.some(
        (turn, index) => turn.text !== stored[index]?.text,
    );
    if (!resolve && !changed) return transcript.text;
    const projected = renderTurnsAsText(turns, resolve);
    return projected || transcript.text;
}

/**
 * One resolver per transcript, in a single query.
 *
 * The export paths walk every transcript a user owns, so asking per
 * transcript would be an N+1 against a table that already joins to people.
 * Returns an empty map when nothing is confirmed, and callers then project
 * nothing, which is the correct no-op.
 *
 * `ownerId` is the user the transcripts belong to, not necessarily the user
 * asking: a speaker is named by the owner, so a reader of a shared transcript
 * must see the owner's naming rather than their own. It also bounds the join
 * to `people`, so a stored `personId` can never reach across a tenant.
 */
export async function buildResolverMap(
    ownerId: string,
    transcriptionIds: readonly string[],
): Promise<Map<string, SpeakerNameResolver>> {
    if (transcriptionIds.length === 0) return new Map();

    const rows = await db
        .select({
            transcriptionId: transcriptSpeakers.transcriptionId,
            label: transcriptSpeakers.label,
            displayName: people.displayName,
        })
        .from(transcriptSpeakers)
        .innerJoin(
            people,
            and(
                eq(people.id, transcriptSpeakers.personId),
                visibleOwnerCondition(people.userId, ownerId),
            ),
        )
        .where(
            and(
                eq(transcriptSpeakers.userId, ownerId),
                eq(transcriptSpeakers.status, "confirmed"),
                inArray(
                    transcriptSpeakers.transcriptionId,
                    transcriptionIds as string[],
                ),
            ),
        );

    return resolverMapFromRows(rows);
}

/**
 * `buildResolverMap` for the Organization's export: shared transcripts of
 * many owners, each named by its owner's attributions, but only with the
 * Organization's people, as the Organization view names them.
 */
export async function buildOrgResolverMap(
    transcriptionIds: readonly string[],
): Promise<Map<string, SpeakerNameResolver>> {
    if (transcriptionIds.length === 0) return new Map();

    const rows = await db
        .select({
            transcriptionId: transcriptSpeakers.transcriptionId,
            label: transcriptSpeakers.label,
            displayName: people.displayName,
        })
        .from(transcriptSpeakers)
        .innerJoin(
            people,
            and(
                eq(people.id, transcriptSpeakers.personId),
                orgOwnedCondition(people.userId),
            ),
        )
        .innerJoin(
            transcriptions,
            and(
                eq(transcriptions.id, transcriptSpeakers.transcriptionId),
                eq(transcriptions.userId, transcriptSpeakers.userId),
            ),
        )
        .where(
            and(
                eq(transcriptSpeakers.status, "confirmed"),
                inArray(
                    transcriptSpeakers.transcriptionId,
                    transcriptionIds as string[],
                ),
            ),
        );

    return resolverMapFromRows(rows);
}

/** The grouping rule, separated from the query so it can be tested alone. */
export function resolverMapFromRows(
    rows: readonly {
        transcriptionId: string;
        label: string;
        displayName: string;
    }[],
): Map<string, SpeakerNameResolver> {
    const byTranscript = new Map<
        string,
        { label: string; displayName: string }[]
    >();

    for (const row of rows) {
        const group = byTranscript.get(row.transcriptionId) ?? [];
        group.push(row);
        byTranscript.set(row.transcriptionId, group);
    }

    return new Map(
        [...byTranscript].map(([transcriptionId, group]) => [
            transcriptionId,
            namesFromRows(group),
        ]),
    );
}
