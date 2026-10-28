import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
    itemKnowledgeLegacyRecords,
    itemKnowledgeNewRecordIds,
} from "@/db/queries/folder-knowledge";
import { chatterItems, learnRuns, transcriptions } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { getTranscriptSpeakers } from "@/lib/knowledge/attribution";
import { listCorrections } from "@/lib/knowledge/corrections";
import type { ItemKnowledgeTab } from "@/lib/knowledge/folder-knowledge";
import { readScopedKnowledge } from "@/lib/knowledge/read-folder-knowledge";
import { readableScopes } from "@/lib/knowledge/scope";
import { labelsFromTurns } from "@/lib/knowledge/speaker-label-rules";
import { loadReview } from "@/lib/learn/review";
import { withSpeakerProposalContext } from "@/lib/learn/speaker-proposal-context";
import { resolveItemProfile } from "@/lib/profiles/resolve";
import { readConfirmedLanguage } from "@/lib/recordings/read-language";
import { requireRecordingView } from "@/lib/sharing/access";
import type { RecordingView } from "@/lib/sharing/view";
import { preferredTranscript } from "@/lib/transcription/preferred-source";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";

/** Item evidence through the same reader as folder knowledge, after view authorization. */
export async function readItemKnowledge(
    viewerId: string,
    itemId: string,
    view: RecordingView,
    tab: ItemKnowledgeTab,
    offset = 0,
    curates = false,
) {
    const access = await requireRecordingView(viewerId, itemId, view, {
        kinds: ["audio", "mail"],
    });
    const canReview =
        view !== "received" &&
        (viewerId === access.ownerUserId || (access.shared && curates));
    const knowledgeView = access.shared ? "org" : "private";
    const scopes =
        view === "received"
            ? []
            : readableScopes(
                  {
                      kind: "recording",
                      ownerUserId: viewerId,
                      shared: access.shared,
                  },
                  access.orgUserId,
              );
    const [item] = await db
        .select({ title: chatterItems.title })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, itemId),
                eq(chatterItems.userId, access.ownerUserId),
            ),
        )
        .limit(1);
    const [run] = await db
        .select()
        .from(learnRuns)
        .where(
            and(
                eq(learnRuns.itemId, itemId),
                eq(learnRuns.userId, access.ownerUserId),
                eq(learnRuns.view, knowledgeView),
            ),
        )
        .orderBy(desc(learnRuns.createdAt))
        .limit(1);
    const transcripts =
        access.kind === "audio"
            ? await db
                  .select()
                  .from(transcriptions)
                  .where(
                      and(
                          eq(transcriptions.recordingId, itemId),
                          eq(transcriptions.userId, access.ownerUserId),
                      ),
                  )
            : [];
    const transcript = preferredTranscript(transcripts);
    const rows = transcript
        ? await getTranscriptSpeakers(
              access.ownerUserId,
              transcript.id,
              access.shared ? { orgPeopleOnly: true } : undefined,
          )
        : [];
    const visibleRows = rows.filter(
        (row) => canReview || row.status === "confirmed",
    );
    const contextualRows =
        canReview && transcript
            ? await withSpeakerProposalContext(
                  access.ownerUserId,
                  access.shared
                      ? (access.orgUserId ?? access.ownerUserId)
                      : access.ownerUserId,
                  transcript.id,
                  transcript.revision,
                  visibleRows,
              )
            : visibleRows.map((row) => ({ ...row, proposal: undefined }));
    const labels = labelsFromTurns(readTranscriptTurns(transcript) ?? []);
    const speakers = [
        ...new Set([...labels, ...visibleRows.map((row) => row.label)]),
    ].map((label) => {
        const row = contextualRows.find(
            (entry) =>
                entry.label === label &&
                (canReview || entry.status === "confirmed"),
        );
        return {
            label,
            name: row?.personName ?? null,
            status: row?.status ?? null,
            source: row?.proposal?.source ?? row?.source ?? null,
            unknown: row?.markedUnknown ?? false,
        };
    });
    const review = canReview
        ? await loadReview({ ...access, view: knowledgeView })
        : null;
    const baseScope = {
        itemId,
        folderId: "",
        ownerId: access.ownerUserId,
        viewerId,
        shared: access.shared,
        allOwnedItems: false,
        scopes,
    };
    const scope = {
        ...baseScope,
        legacyRecordsByRun: await itemKnowledgeLegacyRecords(baseScope),
    };
    const title = decryptText(item?.title);
    const requested =
        tab === "speakers" ||
        (tab === "models" && (view === "received" || access.kind === "mail"))
            ? "people"
            : tab;
    let language: string | null = null;
    const namedRecordIds = new Set<string>();
    if (requested === "models") {
        language = await readConfirmedLanguage(access.ownerUserId, itemId);
        if (!language) {
            try {
                const profile = await resolveItemProfile(
                    itemId,
                    knowledgeView,
                    access.ownerUserId,
                );
                language =
                    "transcribe" in profile.settings.steps
                        ? profile.settings.steps.transcribe.language || null
                        : null;
            } catch (error) {
                if (
                    !(error instanceof AppError) ||
                    (error.code !== ErrorCode.CONFLICT &&
                        error.code !== ErrorCode.NOT_FOUND)
                )
                    throw error;
            }
        }
        for (const row of rows)
            if (row.personId) namedRecordIds.add(row.personId);
        const corrections = transcript
            ? await listCorrections(access.ownerUserId, transcript.id, db, {
                  shared: access.shared,
              })
            : [];
        for (const correction of corrections) {
            const target =
                correction.targetPersonId ?? correction.targetEntityId;
            if (target) namedRecordIds.add(target);
        }
    }
    const data = await readScopedKnowledge(
        scope,
        {},
        requested,
        offset,
        language,
        namedRecordIds,
    );
    const counts = await Promise.all(
        (["people", "things", "corrections", "facts"] as const).map(
            async (entry) => {
                const result =
                    entry === requested
                        ? data
                        : await readScopedKnowledge(scope, {}, entry, 0);
                return [entry, "total" in result ? result.total : 0] as const;
            },
        ),
    );
    const newRecordIds =
        view === "received" ? [] : await itemKnowledgeNewRecordIds(scope);
    const metadata = {
        id: itemId,
        kind: access.kind,
        title,
        canReview,
        modelContextAvailable: view !== "received",
        speakers,
        newRecordIds,
        counts: {
            people: counts[0][1],
            things: counts[1][1],
            corrections: counts[2][1],
            facts: counts[3][1],
            speakers: speakers.length,
            models: access.kind === "mail" ? 3 : 5,
        },
        learn: run
            ? {
                  status: run.status,
                  source:
                      transcripts.find(
                          (entry) => entry.id === run.transcriptionId,
                      )?.source ?? null,
                  at: (run.finishedAt ?? run.createdAt).toISOString(),
                  applied: run.stats?.applied ?? null,
                  skipped: run.stats?.skipped ?? null,
                  dismissed: run.stats?.dismissed ?? null,
                  pending:
                      canReview && run.status === "ready"
                          ? (review?.items.length ?? 0)
                          : 0,
              }
            : null,
        review,
    };
    if (tab === "models" && (view === "received" || access.kind === "mail"))
        return {
            itemCount: 1,
            subfolderCount: 0,
            tab: "models" as const,
            item: metadata,
            language: null,
            transcription: {
                terms: [],
                belowCut: [],
                total: 0,
                sent: 0,
                limit: 0,
            },
            correction: { count: 0, limit: 0, previewCount: 0, preview: "" },
        };
    if (tab === "speakers")
        return {
            ...data,
            tab: "speakers" as const,
            total: speakers.length,
            nextOffset: null,
            item: metadata,
        };
    return { ...data, item: metadata };
}

export type ItemKnowledgeResponse = Awaited<
    ReturnType<typeof readItemKnowledge>
>;
