/**
 * Detecting the topics of one transcript and storing them on it.
 *
 * Topics are written onto the transcript row itself, so they follow the
 * writer rule: the owner detects them on the private view, and while the
 * recording is shared the organization account on the Organization view.
 * The prompt and output language follow the view, and the provider is the
 * actor's, who pays (`resolveRunContext`); the row is the owner's either
 * way, as a shared recording is one recording.
 */

import { and, eq, isNull } from "drizzle-orm";
import { OpenAI } from "openai";
import { db } from "@/db";
import { recordings, transcriptions, users } from "@/db/schema";
import { buildChatCompletionParams } from "@/lib/ai/chat-completion-params";
import { CONTENT_IS_DATA_DIRECTIVE } from "@/lib/ai/content-directive";
import { enhancementChatModel } from "@/lib/ai/enhancement-provider";
import { getAiOutputLanguageDirective } from "@/lib/ai/summary-presets";
import { recordChatCompletionUsage } from "@/lib/ai/usage-cost";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { decryptJsonField, encryptJsonField } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { retryWithBackoff } from "@/lib/jobs/backoff";
import { nudge } from "@/lib/jobs/nudge";
import { isRetryableError } from "@/lib/jobs/retryable";
import type { JobProgress } from "@/lib/jobs/types";
import { modelInput } from "@/lib/learn/llm-input";
import { markSummaryStepDoneInTx } from "@/lib/pipeline/state";
import { captureServerEvent } from "@/lib/posthog-server";
import { resolveTopicPrompt } from "@/lib/profiles/prompts";
import { resolveStepProvider } from "@/lib/profiles/providers";
import { resolveItemProfile } from "@/lib/profiles/resolve";
import { resolveManualItemProfile } from "@/lib/profiles/resolve-manual";
import type { AudioProfileSettings } from "@/lib/profiles/settings";
import { resolveRunContext } from "@/lib/sharing/run-context";
import type { RecordingView } from "@/lib/sharing/view";
import {
    contentWriterRefusal,
    contentWriterRefusalNow,
    sharingOrgUserId,
    writerRefusalError,
} from "@/lib/sharing/writer";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";
import {
    anchorTopics,
    finishTopics,
    isTopicList,
    joinWindowTopics,
    parseTopicsReply,
} from "./anchor";
import type { StoredTopics } from "./stored-topics";
import {
    buildTimeMarks,
    renderTimedTranscript,
    splitIntoWindows,
    type TranscriptTopic,
} from "./timeline";
import { TOPIC_SYSTEM_PROMPT } from "./topic-presets";

/** Transcript sources topics can be detected on. */
export type TopicSource = "plaud" | "riffado";

/**
 * Transcript per request, in rendered characters (about 10k tokens), and how
 * much consecutive requests share. Sized for the smaller context windows of
 * the OpenAI-compatible models people run themselves, not for the largest.
 */
const WINDOW_CHARS = 40_000;
const WINDOW_OVERLAP_CHARS = 4_000;

const CALL_RETRY_ATTEMPTS = 3;
const CALL_RETRY_BASE_MS = 1_500;
const CALL_RETRY_MAX_MS = 15_000;

type TopicsRecipe = Pick<
    StoredTopics,
    | "provider"
    | "model"
    | "profileRevisionId"
    | "templateId"
    | "promptTemplate"
    | "outputLanguage"
>;

function matchingStoredTopics(
    row: { topics: unknown; topicsInputFingerprint: string | null },
    inputFingerprint: string | null,
    recipe: TopicsRecipe,
): StoredTopics | null {
    if (row.topicsInputFingerprint !== inputFingerprint) return null;
    const stored = decryptJsonField<Partial<StoredTopics>>(row.topics);
    if (
        !stored ||
        !isTopicList(stored.topics) ||
        stored.topics.length === 0 ||
        stored.provider !== recipe.provider ||
        stored.model !== recipe.model ||
        stored.profileRevisionId !== recipe.profileRevisionId ||
        stored.templateId !== recipe.templateId ||
        stored.promptTemplate !== recipe.promptTemplate ||
        stored.outputLanguage !== recipe.outputLanguage
    ) {
        return null;
    }
    return stored as StoredTopics;
}

export interface GenerateTopicsOptions {
    trigger: "manual" | "auto";
    jobId?: string;
    onProgress?: (progress: JobProgress) => void;
    view?: RecordingView;
}

export interface GenerateTopicsResult {
    topics: TranscriptTopic[];
    provider: string;
    model: string;
    templateId: string;
    windows: number;
    inputFingerprint?: string | null;
}

export async function generateTopicsForTranscript(
    actorUserId: string,
    recordingId: string,
    source: TopicSource,
    opts: GenerateTopicsOptions,
): Promise<GenerateTopicsResult> {
    const ctx = await resolveRunContext(
        actorUserId,
        recordingId,
        opts.view ?? "private",
    );
    if (!ctx) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }
    // The owner's rows in either view.
    const userId = ctx.ownerUserId;
    const [recording] = await db
        .select({ id: recordings.id })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);
    if (!recording) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }
    // Refused before the provider is paid, and again under the lock where
    // the topics are written.
    const refusal = await contentWriterRefusalNow({
        recordingId,
        ownerUserId: userId,
        actorUserId: ctx.actorUserId,
        actsForOrganization: ctx.actsForOrganization,
    });
    if (refusal) throw writerRefusalError(refusal);

    const [transcript] = await db
        .select()
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, userId),
                eq(transcriptions.source, source),
            ),
        )
        .limit(1);
    if (!transcript) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "This recording has no such transcript",
            400,
        );
    }
    const turns = readTranscriptTurns(transcript);
    if (!turns) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "This transcript has no timings, so topics cannot be detected on it",
            400,
        );
    }

    const profile = await (opts.trigger === "manual"
        ? resolveManualItemProfile
        : resolveItemProfile)(
        recordingId,
        ctx.view,
        ctx.ownerUserId,
        ctx.actorUserId,
        opts.trigger === "auto" ? "topics" : undefined,
    );
    const settings = profile.settings as AudioProfileSettings;
    const [owner] = await db
        .select({ uiLocale: users.uiLocale })
        .from(users)
        .where(eq(users.id, ctx.ownerUserId))
        .limit(1);
    const resolvedPrompt = resolveTopicPrompt({
        settings: settings.steps.topics,
        outputLanguage: settings.steps.summary.outputLanguage,
        contentLanguage: transcript.detectedLanguage,
        uiLocale: owner?.uiLocale === "cs-CZ" ? "cs-CZ" : "en",
    });
    const templateId = settings.steps.topics.preset;
    const promptTemplate = resolvedPrompt.text;

    // The provider is the actor's, who pays.
    const resolved = await resolveStepProvider({
        step: "topics",
        pin: settings.steps.topics.provider,
        actorUserId: ctx.actorUserId,
    });
    if (resolved.kind !== "credential") {
        throw new AppError(
            ErrorCode.AI_PROVIDER_NOT_CONFIGURED,
            "No AI provider configured",
            400,
        );
    }
    const credentials = resolved.credential;
    const model = enhancementChatModel(credentials);
    const recipe: TopicsRecipe = {
        provider: credentials.provider,
        model,
        profileRevisionId: profile.revisionId || null,
        templateId,
        promptTemplate,
        outputLanguage: settings.steps.summary.outputLanguage,
    };
    const systemContent = [
        TOPIC_SYSTEM_PROMPT,
        CONTENT_IS_DATA_DIRECTIVE,
        getAiOutputLanguageDirective(recipe.outputLanguage),
    ].join("\n\n");

    // Read with its corrections applied (same turns, same times), and the
    // fingerprint of that kept with the topics.
    const input = await modelInput(transcript);
    const readTurns = input.turns ?? turns;
    // Inner marks follow the words as heard, which the audio's times do.
    const marks = buildTimeMarks(readTurns, { toHeard: input.toHeard });
    const endMs = Math.max(...readTurns.map((turn) => turn.endMs));
    const windows = splitIntoWindows(marks, WINDOW_CHARS, WINDOW_OVERLAP_CHARS);
    const stepContent = {
        contentId: transcript.id,
        contentSourceId: source,
        contentRevision: transcript.revision,
    };

    const cached =
        opts.trigger === "auto"
            ? matchingStoredTopics(transcript, input.fingerprint, recipe)
            : null;
    if (cached) {
        const orgUserId = await sharingOrgUserId();
        const actsForOrganization =
            ctx.actsForOrganization &&
            (await userCuratesOrganizationNow(ctx.actorUserId));
        const outcome = await db.transaction(async (tx) => {
            await tx
                .select({ id: recordings.id })
                .from(recordings)
                .where(
                    and(
                        eq(recordings.id, recordingId),
                        eq(recordings.userId, userId),
                    ),
                )
                .for("update");
            const shared = await contentWriterRefusal(tx, {
                recordingId,
                ownerUserId: userId,
                actorUserId: ctx.actorUserId,
                orgUserId,
                actsForOrganization,
            });
            if (shared) throw writerRefusalError(shared);
            const [current] = await tx
                .select({
                    topics: transcriptions.topics,
                    topicsInputFingerprint:
                        transcriptions.topicsInputFingerprint,
                })
                .from(transcriptions)
                .where(
                    and(
                        eq(transcriptions.id, transcript.id),
                        eq(transcriptions.userId, userId),
                        eq(transcriptions.text, transcript.text),
                    ),
                )
                .limit(1);
            const stored = current
                ? matchingStoredTopics(current, input.fingerprint, recipe)
                : null;
            if (!stored) return { stored: null, advance: false };
            const advance = opts.jobId
                ? false
                : await markSummaryStepDoneInTx(tx, {
                      itemId: recordingId,
                      userId,
                      view: ctx.view,
                      step: "topics",
                      content: stepContent,
                      inputFingerprint: input.fingerprint,
                  });
            return { stored, advance };
        });
        if (outcome.stored) {
            if (outcome.advance) nudge();
            return {
                topics: outcome.stored.topics,
                provider: outcome.stored.provider,
                model: outcome.stored.model,
                templateId: outcome.stored.templateId,
                windows: windows.length,
                inputFingerprint: input.fingerprint,
            };
        }
    }

    const openai = new OpenAI({
        apiKey: credentials.apiKey,
        baseURL: credentials.baseUrl || undefined,
        maxRetries: resolved.organizationCredential ? 0 : undefined,
    });
    const topicsPerWindow: TranscriptTopic[][] = [];
    for (const [index, window] of windows.entries()) {
        opts.onProgress?.({
            phase: "windows",
            completed: index,
            total: windows.length,
        });
        const timed = renderTimedTranscript(window.marks);
        const part =
            windows.length > 1
                ? `\n\nThis is part ${index + 1} of ${windows.length} of a longer transcript. Its first topic may continue from the previous part.`
                : "";
        const prompt =
            promptTemplate.replaceAll("{transcription}", () => timed) + part;

        const reply = await retryWithBackoff({
            attempts: CALL_RETRY_ATTEMPTS,
            baseMs: CALL_RETRY_BASE_MS,
            maxMs: CALL_RETRY_MAX_MS,
            jitter: 0.5,
            isRetryable: isRetryableError,
            run: async () => {
                await resolved.reserveCall();
                const response = await openai.chat.completions.create(
                    buildChatCompletionParams({
                        model,
                        messages: [
                            { role: "system", content: systemContent },
                            { role: "user", content: prompt },
                        ],
                        temperature: 0.3,
                        maxOutputTokens: credentials.maxOutputTokens,
                        maxTokens: 2000,
                    }),
                );
                await recordChatCompletionUsage(
                    {
                        recordingId,
                        ownerUserId: ctx.ownerUserId,
                        actorUserId: ctx.actorUserId,
                        payerUserId: resolved.payerUserId,
                        operation: "topics",
                        provider: credentials.provider,
                        model,
                        baseUrl: credentials.baseUrl,
                        credentialId: credentials.id,
                    },
                    response,
                );
                return response.choices[0]?.message?.content?.trim() || "";
            },
            onRetry: ({ attempt, delayMs }) => {
                console.warn(
                    `[topics] window ${index + 1} attempt ${attempt} failed, retrying in ${delayMs}ms`,
                );
            },
        });

        const candidates = parseTopicsReply(reply);
        if (!candidates) {
            console.warn(
                `[topics] window ${index + 1} of ${windows.length} returned no topic list`,
            );
        }
        topicsPerWindow.push(
            anchorTopics(candidates ?? [], window.marks, endMs),
        );
    }

    const topics = finishTopics(
        joinWindowTopics(windows, topicsPerWindow),
        endMs,
    );
    if (topics.length === 0) {
        throw new AppError(
            ErrorCode.AI_PROVIDER_API_ERROR,
            "The model's reply held no usable topics",
            502,
        );
    }

    const stored: StoredTopics = {
        topics,
        ...recipe,
        generatedAt: new Date().toISOString(),
    };
    // Written only if the transcript is still the one the topics were read
    // from. Every write of a transcript re-encrypts its text, so an unchanged
    // ciphertext means an unchanged transcript; a re-transcription that
    // landed meanwhile has already cleared topics, and must keep them clear.
    // Under the recording lock sharing takes, so a recording shared while
    // the model ran keeps what it was shared with.
    const orgUserId = await sharingOrgUserId();
    // Before the lock: it may ask the identity provider.
    const actsForOrganization =
        ctx.actsForOrganization &&
        (await userCuratesOrganizationNow(ctx.actorUserId));
    const outcome = await db.transaction(async (tx) => {
        await tx
            .select({ id: recordings.id })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, userId),
                ),
            )
            .for("update");
        const shared = await contentWriterRefusal(tx, {
            recordingId,
            ownerUserId: userId,
            actorUserId: ctx.actorUserId,
            orgUserId,
            actsForOrganization,
        });
        if (shared) throw writerRefusalError(shared);
        const written = await tx
            .update(transcriptions)
            .set({
                topics: encryptJsonField(stored),
                topicsInputFingerprint: input.fingerprint,
            })
            .where(
                and(
                    eq(transcriptions.id, transcript.id),
                    eq(transcriptions.userId, userId),
                    eq(transcriptions.text, transcript.text),
                ),
            )
            .returning({ id: transcriptions.id });
        const advance =
            written.length > 0 && opts.trigger === "auto" && !opts.jobId
                ? await markSummaryStepDoneInTx(tx, {
                      itemId: recordingId,
                      userId,
                      view: ctx.view,
                      step: "topics",
                      content: stepContent,
                      inputFingerprint: input.fingerprint,
                  })
                : false;
        return { written, advance };
    });
    if (outcome.written.length === 0) {
        throw new AppError(
            ErrorCode.CONFLICT,
            "The transcript changed while its topics were being detected. Detect them again.",
            409,
        );
    }
    if (outcome.advance) nudge();

    await captureServerEvent({
        distinctId: ctx.actorUserId,
        event: "topics_generated",
        properties: {
            trigger: opts.trigger,
            provider: credentials.provider,
            topic_count: topics.length,
            windows: windows.length,
        },
    });

    return {
        topics,
        provider: credentials.provider,
        model,
        templateId,
        windows: windows.length,
        inputFingerprint: input.fingerprint,
    };
}
