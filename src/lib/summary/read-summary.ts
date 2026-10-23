/**
 * Read a stored summary back out in the shape clients render.
 *
 * Extracted because two places now need it. The GET handler always did, and
 * the streaming POST does too: generation happens on a worker, so the route
 * learns only that the job finished and has to fetch what it produced. Having
 * one function means the summary a client receives from a completed job is
 * byte-for-byte what it would get by reloading the page.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { aiEnhancements } from "@/db/schema";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import { itemScopeFingerprint } from "@/lib/pipeline/scope-fingerprint";
import type { RecordingView } from "@/lib/sharing/view";
import type {
    EnhancementSource,
    ProcessingRunInputs,
} from "@/lib/transcription/persist";
import type { MultiPassProvenance } from "./multi-pass";

export interface StoredSummary {
    /** Null for a row that exists but carries no summary text. */
    summary: string | null;
    keyPoints: string[];
    actionItems: string[];
    source: EnhancementSource;
    transcriptionId: string | null;
    provider: string | null;
    model: string | null;
    multiPass?: MultiPassProvenance;
    /** What the model read, see `llmInputFingerprint`; null when unknown. */
    inputFingerprint: string | null;
    scopeChanged: boolean;
    /** Internal provenance used to fence downstream title generation. */
    runInputs: ProcessingRunInputs | null;
    createdAt: Date;
}

/** Plaud-owned summary data that can seed task hints or unmatched proposals. */
export interface PlaudTaskSource {
    summary: string;
    actionItems: string[];
    transcriptionId: string | null;
}

/** Read the Plaud summary fields used by Summary-step task processing. */
export async function readPlaudTaskSource(
    userId: string,
    recordingId: string,
): Promise<PlaudTaskSource | null> {
    const [row] = await db
        .select({
            summary: aiEnhancements.summary,
            actionItems: aiEnhancements.actionItems,
            transcriptionId: aiEnhancements.transcriptionId,
        })
        .from(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.itemId, recordingId),
                eq(aiEnhancements.userId, userId),
                eq(aiEnhancements.source, "plaud"),
            ),
        )
        .limit(1);
    if (!row) return null;
    const actionItems = decryptJsonField<unknown[]>(row.actionItems) ?? [];
    return {
        summary: decryptText(row.summary) ?? "",
        actionItems: actionItems.flatMap((item) =>
            typeof item === "string" && item.trim() ? [item.trim()] : [],
        ),
        transcriptionId: row.transcriptionId,
    };
}

/** Read only Plaud's action-item suggestions for an AI summary prompt. */
export async function readPlaudActionItems(
    userId: string,
    recordingId: string,
): Promise<string[]> {
    return (await readPlaudTaskSource(userId, recordingId))?.actionItems ?? [];
}

export async function readStoredSummary(
    userId: string,
    recordingId: string,
    source?: EnhancementSource,
    view: RecordingView = "private",
): Promise<StoredSummary | null> {
    const conditions = [
        eq(aiEnhancements.itemId, recordingId),
        eq(aiEnhancements.userId, userId),
    ];
    if (source) conditions.push(eq(aiEnhancements.source, source));

    const rows = await db
        .select()
        .from(aiEnhancements)
        .where(and(...conditions));
    const enhancement = source
        ? rows[0]
        : (rows.find((row) => row.source === "riffado") ?? rows[0]);

    if (!enhancement) return null;
    const inputs = enhancement.inputs as { scopeFingerprint?: unknown } | null;
    const storedScope = inputs?.scopeFingerprint;
    const scopeChanged =
        typeof storedScope === "string" &&
        view !== "received" &&
        storedScope !== (await itemScopeFingerprint(recordingId, view, userId));
    return storedSummaryOf(enhancement, scopeChanged);
}

/** A stored summary row, decrypted into the shape clients render. */
export function storedSummaryOf(
    enhancement: typeof aiEnhancements.$inferSelect,
    scopeChanged = false,
): StoredSummary {
    return {
        // Legacy plaintext rows pass through verbatim during the backfill
        // window; `decryptText` is a no-op on them.
        summary: decryptText(enhancement.summary) ?? null,
        keyPoints: decryptJsonField<string[]>(enhancement.keyPoints) ?? [],
        actionItems: decryptJsonField<string[]>(enhancement.actionItems) ?? [],
        source: enhancement.source === "plaud" ? "plaud" : ("riffado" as const),
        transcriptionId: enhancement.transcriptionId,
        provider: enhancement.provider,
        model: enhancement.model,
        // Nested, matching what POST returns, so a client has one shape to
        // render rather than flat columns here and an object there. NULL
        // rounds means the summary predates multi-pass or was single-pass.
        multiPass:
            enhancement.multiPassRounds == null
                ? undefined
                : {
                      roundsRequested: enhancement.multiPassRounds,
                      passesUsed: enhancement.multiPassUsed ?? 0,
                      merged: enhancement.multiPassMerged ?? false,
                  },
        inputFingerprint: enhancement.inputFingerprint ?? null,
        scopeChanged,
        runInputs: enhancement.inputs as ProcessingRunInputs | null,
        createdAt: enhancement.createdAt,
    };
}

/** Read both source-scoped summaries for a recording. */
export async function readStoredSummaries(
    userId: string,
    recordingId: string,
    view: RecordingView = "private",
): Promise<StoredSummary[]> {
    const rows = await db
        .select()
        .from(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.itemId, recordingId),
                eq(aiEnhancements.userId, userId),
            ),
        );
    const hasStoredScope = rows.some((row) => {
        const inputs = row.inputs as { scopeFingerprint?: unknown } | null;
        return typeof inputs?.scopeFingerprint === "string";
    });
    const currentScope =
        hasStoredScope && view !== "received"
            ? await itemScopeFingerprint(recordingId, view, userId)
            : null;
    const ordered = (["plaud", "riffado"] as const).flatMap((source) => {
        const row = rows.find((candidate) => candidate.source === source);
        return row ? [row] : [];
    });
    return ordered.map((row) => {
        const inputs = row.inputs as { scopeFingerprint?: unknown } | null;
        return storedSummaryOf(
            row,
            view !== "received" &&
                typeof inputs?.scopeFingerprint === "string" &&
                inputs.scopeFingerprint !== currentScope,
        );
    });
}
