import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { transcriptions } from "@/db/schema";
import { modelInput } from "@/lib/learn/llm-input";
import { readStoredSummary } from "@/lib/summary/read-summary";

export type TitleInput = { text: string; source: "summary" | "transcript" };

/** Prefer the complete summary, then the corrected Riffado transcript. */
export async function readTitleInput(
    userId: string,
    recordingId: string,
): Promise<TitleInput | null> {
    const summary = await readStoredSummary(userId, recordingId);
    if (summary?.summary?.trim()) {
        return {
            text: [summary.summary, ...summary.keyPoints].join("\n"),
            source: "summary",
        };
    }
    const [transcript] = await db
        .select()
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, userId),
                eq(transcriptions.source, "riffado"),
            ),
        )
        .limit(1);
    if (!transcript) return null;
    const input = await modelInput(transcript);
    return input.text.trim()
        ? { text: input.text, source: "transcript" }
        : null;
}
