import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { chatterItems, transcriptions } from "@/db/schema";
import { readItemContent } from "@/lib/content/read-item-content";
import { renderMailForModel } from "@/lib/content/render-mail";
import { decryptText } from "@/lib/encryption/fields";
import { modelInput } from "@/lib/learn/llm-input";
import { maskedContentForModel } from "@/lib/mail/redact";
import { readStoredSummary } from "@/lib/summary/read-summary";

export interface TitleInputFence {
    contentId: string;
    contentSourceId: string;
    contentRevision: number;
    profileRevisionId: string | null;
}

export type TitleInput = {
    text: string;
    source: "summary" | "transcript";
    fence?: TitleInputFence;
};

/** Prefer the complete summary, then the corrected Riffado transcript. */
export async function readTitleInput(
    userId: string,
    recordingId: string,
): Promise<TitleInput | null> {
    const summary = await readStoredSummary(userId, recordingId);
    if (summary?.summary?.trim()) {
        const inputs = summary.runInputs;
        const fence =
            inputs &&
            typeof inputs.contentId === "string" &&
            typeof inputs.contentSourceId === "string" &&
            typeof inputs.contentRevision === "number"
                ? {
                      contentId: inputs.contentId,
                      contentSourceId: inputs.contentSourceId,
                      contentRevision: inputs.contentRevision,
                      profileRevisionId:
                          typeof inputs.itemProfileRevisionId === "string"
                              ? inputs.itemProfileRevisionId
                              : null,
                  }
                : undefined;
        return {
            text: [summary.summary, ...summary.keyPoints].join("\n"),
            source: "summary",
            ...(fence ? { fence } : {}),
        };
    }
    const [item] = await db
        .select({
            kind: chatterItems.kind,
            title: chatterItems.title,
            occurredAt: chatterItems.occurredAt,
        })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, recordingId),
                eq(chatterItems.userId, userId),
            ),
        )
        .limit(1);
    if (item?.kind === "mail") {
        const content = await readItemContent(userId, recordingId);
        if (!content) return null;
        const text = renderMailForModel(await maskedContentForModel(content), {
            subject: decryptText(item.title),
            sentAt: item.occurredAt,
        });
        return text.trim()
            ? {
                  text,
                  source: "transcript",
                  fence: {
                      contentId: content.sourceId,
                      contentSourceId: "mail",
                      contentRevision: content.revision,
                      profileRevisionId: null,
                  },
              }
            : null;
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
    const fence =
        typeof transcript.id === "string" &&
        typeof transcript.source === "string" &&
        typeof transcript.revision === "number"
            ? {
                  contentId: transcript.id,
                  contentSourceId: transcript.source,
                  contentRevision: transcript.revision,
                  profileRevisionId: transcript.profileRevisionId ?? null,
              }
            : undefined;
    return input.text.trim()
        ? {
              text: input.text,
              source: "transcript",
              ...(fence ? { fence } : {}),
          }
        : null;
}
