import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { audioItemColumns, recordingItemJoin } from "@/db/items";
import { chatterItems, recordings, userSettings, users } from "@/db/schema";
import { CONTENT_IS_DATA_DIRECTIVE } from "@/lib/ai/content-directive";
import { isPresetId, resolveTemplate } from "@/lib/ai/prompt-templates";
import {
    getAiOutputLanguageDirective,
    localizedSummaryPrompt,
    normalizeSummaryPromptConfig,
    SUMMARY_MARKDOWN_DIRECTIVE,
    SUMMARY_SPEAKER_DIRECTIVE,
    SUMMARY_TEMPLATE_KIND,
} from "@/lib/ai/summary-presets";
import { decryptJsonField } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { exportRecordingSidecarsIfEnabled } from "@/lib/export/document-sidecars";
import { modelInput } from "@/lib/learn/llm-input";
import {
    agendaPlanBlock,
    loadRecordingAgenda,
} from "@/lib/meetings/pipeline-context";
import {
    SUMMARY_AGENDA_DIRECTIVE,
    SUMMARY_AGENDA_MERGE_DIRECTIVE,
} from "@/lib/meetings/summary-directive";
import { pipelineDriver } from "@/lib/pipeline/driver";
import { itemScopeFingerprint } from "@/lib/pipeline/scope-fingerprint";
import { readProcessing } from "@/lib/pipeline/state";
import { captureServerEvent } from "@/lib/posthog-server";
import {
    BUILTIN_PROMPTS_VERSION,
    resolveSummaryPrompt,
} from "@/lib/profiles/prompts";
import {
    loadSelectedProfileRevision,
    resolveItemProfile,
} from "@/lib/profiles/resolve";
import { resolveManualItemProfile } from "@/lib/profiles/resolve-manual";
import type { AudioProfileSettings } from "@/lib/profiles/settings";
import {
    normalizeDetectedLanguage,
    recordingOutputLanguage,
} from "@/lib/recordings/language";
import type { TitleInputFence } from "@/lib/recordings/title-input";
import type { RecordingView } from "@/lib/sharing/access";
import { notifyIfShared } from "@/lib/sharing/notify";
import { resolveRunContext } from "@/lib/sharing/run-context";
import {
    contentWriterRefusalNow,
    writerRefusalError,
} from "@/lib/sharing/writer";
import { taskViewerById } from "@/lib/tasks/access";
import {
    buildPlaudActionItemHints,
    SUMMARY_TASKS_DIRECTIVE,
    SUMMARY_TASKS_MERGE_DIRECTIVE,
} from "@/lib/tasks/directive";
import {
    loadTasksPromptContext,
    resolveTaskProposals,
} from "@/lib/tasks/proposals";
import { upsertEnhancement } from "@/lib/transcription/persist";
import { readPreferredTranscript } from "@/lib/transcription/read-source";
import { generateMailSummary } from "./generate-mail-summary";
import type { MultiPassProgress } from "./multi-pass";
import { resolveMultiPass } from "./multi-pass-resolution";
import { readPlaudActionItems } from "./read-summary";
import { runSummary, summaryModelFor } from "./summary-model";

export interface GenerateSummaryOptions {
    /**
     * Preset id to use for this run. Overrides the user's default
     * `summaryPrompt.selectedPrompt`. When omitted, falls back to the
     * user's saved preset (which itself falls back to "general").
     */
    presetId?: string;
    /** Exact immutable profile revision selected for this manual run. */
    profileRevisionId?: string;
    /** Analytics `trigger` property on the `summary_generated` event. */
    trigger?: "manual" | "auto";
    /**
     * Called as multi-pass work advances. Never called on the single-pass
     * path, which has nothing to report between "started" and "finished".
     *
     * Exists so a caller that can stream -- the route, and later the job
     * worker -- can show which pass is in flight. `generateSummaryForRecording`
     * itself stays a plain awaitable; progress is a side channel, never a
     * requirement.
     */
    onProgress?: (progress: MultiPassProgress) => void;
    /**
     * `org` summarizes the Organization view of a shared recording: the
     * caller is the actor whose provider runs, with the organization's
     * prompts and language.
     */
    view?: RecordingView;
    /** The job this run finishes; cancelled meanwhile, it writes nothing. */
    jobId?: string;
}

export interface GenerateSummaryResult {
    /** The recording's owner, whose summary this is in either view. */
    ownerUserId: string;
    summary: string;
    keyPoints: string[];
    actionItems: string[];
    provider: string;
    model: string;
    /** False when commit fencing discarded output made from old inputs. */
    committed?: boolean;
    /** Inputs captured before the title model may run after this summary. */
    titleFence?: TitleInputFence;
    /** Prompt id actually used. Can differ from the requested preset. */
    promptId: string;
    /**
     * True when the requested/saved prompt id couldn't be resolved (e.g. a
     * custom prompt deleted from another tab) and generation fell back to
     * the default prompt instead.
     */
    promptFallback: boolean;
    /**
     * Present only when this run used multi-pass. Lets the caller say what
     * actually happened -- "3 passes, merged" versus "2 of 3 passes, merge
     * failed" -- instead of silently presenting a degraded result as if it
     * were the full one.
     */
    multiPass?: {
        roundsRequested: number;
        passesUsed: number;
        merged: boolean;
        /**
         * How the run went, in one line. Counts and outcomes only -- safe for
         * the unencrypted job row, unlike anything derived from the replies.
         */
        detail: string;
    };
}

/** Coarse length bucket -- never send raw transcript length or content. */
function bucketLength(chars: number): string {
    if (chars < 2_000) return "short";
    if (chars < 10_000) return "medium";
    if (chars < 50_000) return "long";
    return "very_long";
}

/**
 * Generate (or regenerate) a summary for a recording and persist it via
 * the shared `upsertEnhancement` tombstone-aware upsert. Shared by the
 * manual `/api/recordings/[id]/summary` POST handler and the auto-summarize
 * path that runs after a successful transcription.
 *
 * Throws `AppError` on user-facing failures (no transcript, no provider,
 * tombstoned recording). Provider errors propagate verbatim so callers
 * can decide whether to retry or surface them.
 */
export async function generateSummaryForRecording(
    actorUserId: string,
    recordingId: string,
    opts: GenerateSummaryOptions = {},
): Promise<GenerateSummaryResult> {
    const ctx = await resolveRunContext(
        actorUserId,
        recordingId,
        opts.view ?? "private",
        { kinds: ["audio", "mail"] },
    );
    if (!ctx) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }
    const [item] = await db
        .select({ kind: chatterItems.kind })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, recordingId),
                eq(chatterItems.userId, ctx.ownerUserId),
                isNull(chatterItems.deletedAt),
            ),
        )
        .limit(1);
    if (item?.kind === "mail") {
        return generateMailSummary(ctx, recordingId, opts);
    }
    const orgView =
        ctx.view === "org" || ctx.settingsUserId !== ctx.ownerUserId;
    // The owner's rows in either view: a shared recording is one recording.
    const userId = ctx.contentUserId;
    // Before the provider is paid; the write checks again under the lock.
    const refusal = await contentWriterRefusalNow({
        recordingId,
        ownerUserId: ctx.ownerUserId,
        actorUserId: ctx.actorUserId,
        actsForOrganization: ctx.actsForOrganization,
    });
    if (refusal) throw writerRefusalError(refusal);

    const itemProfileRevisionId =
        (
            await readProcessing(
                recordingId,
                pipelineDriver(ctx.ownerUserId).view,
                ctx.ownerUserId,
            )
        )?.profileRevisionId ?? null;

    const [recording] = await db
        .select(audioItemColumns)
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, ctx.ownerUserId),
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

    const transcription = await readPreferredTranscript(recordingId, userId);

    if (!transcription) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "No custom transcription available. Transcribe the recording with your provider first.",
            400,
        );
    }

    const input = await modelInput(transcription);
    const transcriptText = input.text;
    const agenda = await loadRecordingAgenda(ctx.actorUserId, recordingId);

    const profile = opts.presetId
        ? null
        : opts.profileRevisionId
          ? await loadSelectedProfileRevision({
                revisionId: opts.profileRevisionId,
                actorUserId: ctx.actorUserId,
                channel: "audio",
                view: orgView ? "org" : ctx.view,
            })
          : await ((opts.trigger ?? "manual") === "manual"
                ? resolveManualItemProfile
                : resolveItemProfile)(
                recordingId,
                ctx.view,
                ctx.ownerUserId,
                ctx.actorUserId,
                opts.trigger === "auto" ? "summary" : undefined,
                opts.trigger === "auto" ? opts.jobId : undefined,
            );
    const profileSettings = profile?.settings as
        | AudioProfileSettings
        | undefined;
    const tasksEnabled = profileSettings?.steps.tasks.enabled !== false;
    const titleFence: TitleInputFence = {
        contentId: transcription.id,
        contentSourceId: transcription.source,
        contentRevision: transcription.revision,
        profileRevisionId: itemProfileRevisionId,
    };

    // What the summary is told about tasks: the recording's date, the tasks
    // already decided on it, and open tasks its reviewer may close. Tasks
    // never cost the summary: without them it is made as before.
    const tasksContext = tasksEnabled
        ? await loadTasksPromptContext({
              recording,
              transcriptionId: transcription.id,
              language:
                  recording.confirmedLanguage ?? transcription.detectedLanguage,
              orgView,
              reviewer: await taskViewerById(
                  orgView ? ctx.settingsUserId : ctx.ownerUserId,
              ),
              itemText: transcriptText,
              agendaTasks: agenda?.tasks,
          }).catch(async (error: unknown) => {
              console.error("[summary] task context unavailable:", error);
              return {
                  text: "",
                  refs: new Map<string, string>(),
                  scopeFingerprint: await itemScopeFingerprint(
                      recordingId,
                      orgView ? "org" : ctx.view,
                      ctx.ownerUserId,
                  ),
              };
          })
        : {
              text: "",
              refs: new Map<string, string>(),
              scopeFingerprint: null,
          };
    const [userSettingsRow] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, ctx.settingsUserId))
        .limit(1);
    const [actorSettingsRow] =
        ctx.actorUserId === ctx.settingsUserId
            ? [userSettingsRow]
            : await db
                  .select()
                  .from(userSettings)
                  .where(eq(userSettings.userId, ctx.actorUserId))
                  .limit(1);
    const [owner] = await db
        .select({ uiLocale: users.uiLocale })
        .from(users)
        .where(eq(users.id, ctx.ownerUserId))
        .limit(1);

    const promptConfig = normalizeSummaryPromptConfig(
        userSettingsRow?.summaryPrompt
            ? decryptJsonField(userSettingsRow.summaryPrompt)
            : null,
    );
    const requestedPromptId = opts.presetId || promptConfig.selectedPrompt;
    const legacyPrompt = profile
        ? null
        : resolveTemplate(
              promptConfig,
              requestedPromptId,
              SUMMARY_TEMPLATE_KIND,
          );
    const usedPromptId =
        profileSettings?.steps.summary.preset ?? legacyPrompt?.id;
    if (!usedPromptId) throw new Error("Summary prompt resolution failed");

    const contentLanguage =
        recording.confirmedLanguage ??
        transcription.detectedLanguage ??
        userSettingsRow?.defaultTranscriptionLanguage;
    const outputLanguage = profileSettings
        ? recordingOutputLanguage(
              profileSettings.steps.summary.outputLanguage,
              recording.confirmedLanguage,
          )
        : recordingOutputLanguage(
              userSettingsRow?.aiOutputLanguage,
              recording.confirmedLanguage,
          );
    const profilePrompt = profileSettings
        ? resolveSummaryPrompt({
              settings: profileSettings.steps.summary,
              outputLanguage: outputLanguage ?? "auto",
              contentLanguage,
              uiLocale: owner?.uiLocale === "cs-CZ" ? "cs-CZ" : "en",
          })
        : null;
    const promptTemplate = profilePrompt?.text ?? legacyPrompt?.prompt;
    if (!promptTemplate) throw new Error("Summary prompt resolution failed");
    const selectedTemplate = profile
        ? undefined
        : promptConfig.templates.find(
              (template) => template.id === usedPromptId,
          );
    const builtinPromptsVersion = profilePrompt
        ? profilePrompt.builtinVersion
        : isPresetId(SUMMARY_TEMPLATE_KIND, usedPromptId) &&
            selectedTemplate?.prompt === null
          ? BUILTIN_PROMPTS_VERSION
          : null;

    const summaryModel = await summaryModelFor(
        ctx.actorUserId,
        profileSettings?.steps.summary.provider ?? null,
    );
    const { credentials, model } = summaryModel;

    // Apply the AI output language directive via the system message rather
    // than the user prompt. This separates concerns: the user prompt carries
    // the JSON-shape contract (English keys), the system message carries the
    // output language. Smaller models tend to honor this split more reliably
    // than a combined prompt where language and JSON-shape rules compete.
    const languageDirective = getAiOutputLanguageDirective(outputLanguage);
    // The merge never sees the transcript, so under `auto` it has to take
    // the language from the passes instead.
    const mergeLanguageDirective = getAiOutputLanguageDirective(
        outputLanguage,
        "extractions",
    );

    // `replaceAll` with a function replacer so (a) a custom prompt that
    // references `{transcription}` more than once gets every occurrence
    // expanded, and (b) `$` sequences in the transcript (e.g. `$1`, `$&`)
    // are inserted verbatim instead of being interpreted as
    // `String.prototype.replace` special patterns.
    // The task lists are data the user's recordings hold, so they go with
    // the user's message rather than the instructions.
    const localizedTemplate = profile
        ? promptTemplate
        : localizedSummaryPrompt(
              usedPromptId,
              promptTemplate,
              outputLanguage ?? normalizeDetectedLanguage(contentLanguage),
              selectedTemplate?.prompt === null,
          );
    const plaudActionItems = tasksEnabled
        ? await readPlaudActionItems(ctx.ownerUserId, recordingId).catch(
              (error: unknown) => {
                  console.error(
                      "[summary] Plaud task hints unavailable:",
                      error,
                  );
                  return [];
              },
          )
        : [];
    const plaudHints = buildPlaudActionItemHints(plaudActionItems);
    const prompt = [
        localizedTemplate.replaceAll("{transcription}", () => transcriptText),
        tasksContext.text,
        plaudHints,
        agendaPlanBlock(agenda),
    ]
        .filter(Boolean)
        .join("\n\n");

    const baseSystem =
        "You are a helpful assistant that summarizes audio transcriptions. Always respond with one raw JSON object and nothing else: no code fences, and no text before or after it. Markdown inside the JSON string values is expected.";
    const systemContent = [
        baseSystem,
        CONTENT_IS_DATA_DIRECTIVE,
        SUMMARY_MARKDOWN_DIRECTIVE,
        SUMMARY_SPEAKER_DIRECTIVE,
        tasksEnabled ? SUMMARY_TASKS_DIRECTIVE : "",
        agenda ? SUMMARY_AGENDA_DIRECTIVE : "",
        languageDirective,
    ]
        .filter(Boolean)
        .join(" ");

    // Multi-pass applies to the auto path only if separately enabled: a manual
    // summary is one recording the user is waiting on, while a sync can fire a
    // dozen, and each one multiplies by `rounds`.
    const multiPassResolution = resolveMultiPass({
        profileSummary: profileSettings?.steps.summary ?? null,
        hasProfile: profile !== null,
        actorSettings: actorSettingsRow,
        settings: userSettingsRow,
        trigger: opts.trigger,
    });
    const { payload, multiPass } = await runSummary({
        model: summaryModel,
        usage: {
            itemId: recordingId,
            ownerUserId: ctx.ownerUserId,
            actorUserId: ctx.actorUserId,
            payerUserId: summaryModel.payerUserId,
        },
        systemContent,
        prompt,
        mergeSystem: (mergePrompt) =>
            [
                mergePrompt,
                CONTENT_IS_DATA_DIRECTIVE,
                SUMMARY_MARKDOWN_DIRECTIVE,
                SUMMARY_SPEAKER_DIRECTIVE,
                tasksEnabled ? SUMMARY_TASKS_MERGE_DIRECTIVE : "",
                agenda ? SUMMARY_AGENDA_MERGE_DIRECTIVE : "",
                mergeLanguageDirective,
            ]
                .filter(Boolean)
                .join("\n\n"),
        multiPass: multiPassResolution.config,
        onProgress: opts.onProgress,
        tasksEnabled,
        agendaPointIds: agenda?.points.map((point) => point.id),
    });

    const { summary, keyPoints, actionItems } = payload;
    const tasks = tasksEnabled
        ? await resolveTaskProposals({
              source: "riffado",
              items: payload.taskItems,
              updates: payload.taskUpdates,
              refs: tasksContext.refs,
              ownerUserId: ctx.ownerUserId,
              transcriptionId: transcription.id,
              turns: input.turns,
              language:
                  recording.confirmedLanguage ?? transcription.detectedLanguage,
              orgView,
              reviewer: await taskViewerById(
                  orgView ? ctx.settingsUserId : ctx.ownerUserId,
              ),
              summaryText: summary,
          }).catch((error: unknown) => {
              console.error("[summary] task proposals unavailable:", error);
              return undefined;
          })
        : null;

    const { committed, reason } = await upsertEnhancement({
        userId,
        recordingId,
        transcriptionId: transcription.id,
        summary,
        keyPoints,
        actionItems,
        source: "riffado",
        provider: credentials.provider,
        model,
        multiPass,
        inputFingerprint: input.fingerprint,
        profileRevisionId: profile?.revisionId ?? null,
        builtinPromptsVersion,
        outputLanguage,
        outputFormatLocale: profilePrompt?.formatLocale ?? null,
        payerUserId: summaryModel.payerUserId,
        inputs: {
            contentId: transcription.id,
            contentSourceId: transcription.source,
            contentRevision: transcription.revision,
            itemProfileRevisionId,
            ...(tasksContext.scopeFingerprint
                ? { scopeFingerprint: tasksContext.scopeFingerprint }
                : {}),
            multiPass: multiPassResolution.source,
        },
        allowReaped: (opts.trigger ?? "manual") === "manual",
        actorUserId: ctx.actorUserId,
        actsForOrganization: ctx.actsForOrganization,
        jobId: opts.jobId,
        view: ctx.view,
        tasks,
        agenda: agenda
            ? {
                  id: agenda.id,
                  userId: agenda.userId,
                  version: agenda.version,
                  outcome: payload.agendaOutcome ?? null,
              }
            : undefined,
    });

    if (!committed) {
        if (reason === "outdated") {
            return {
                ownerUserId: ctx.ownerUserId,
                summary,
                keyPoints,
                actionItems,
                provider: credentials.provider,
                model,
                promptId: usedPromptId,
                promptFallback: profile
                    ? false
                    : usedPromptId !== requestedPromptId,
                multiPass,
                committed: false,
                titleFence,
            };
        }
        if (reason === "cancelled") {
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "The run was cancelled before it finished",
                410,
            );
        }
        if (reason) throw writerRefusalError(reason);
        throw new AppError(ErrorCode.NOT_FOUND, "Recording was deleted", 410);
    }

    await exportRecordingSidecarsIfEnabled(
        userId,
        recordingId,
        "summary",
        "riffado",
    );
    await notifyIfShared(recordingId);

    await captureServerEvent({
        distinctId: ctx.actorUserId,
        event: "summary_generated",
        properties: {
            trigger: opts.trigger ?? "manual",
            provider: credentials.provider,
            transcript_length_bucket: bucketLength(transcriptText.length),
            // Counts only -- never prompt or transcript content. Recorded
            // because a degraded run (fewer passes used than requested, or no
            // merge) is otherwise indistinguishable from a clean one.
            multi_pass: multiPass !== undefined,
            multi_pass_rounds: multiPass?.roundsRequested,
            multi_pass_passes_used: multiPass?.passesUsed,
            multi_pass_merged: multiPass?.merged,
        },
    });

    return {
        ownerUserId: ctx.ownerUserId,
        summary,
        keyPoints,
        actionItems,
        provider: credentials.provider,
        model,
        promptId: usedPromptId,
        promptFallback: profile ? false : usedPromptId !== requestedPromptId,
        multiPass,
        committed: true,
        titleFence,
    };
}
