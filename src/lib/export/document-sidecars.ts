import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
    type AudioItemRow,
    audioItemColumns,
    recordingItemJoin,
} from "@/db/items";
import {
    aiEnhancements,
    chatterItems,
    mailContents,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";
import { resolveAiOutputLanguage } from "@/lib/ai/summary-presets";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import { enqueueExportPlansForUser } from "@/lib/folder-exports/jobs";
import {
    type AppLocale,
    defaultLocale,
    normalizeLocale,
} from "@/lib/i18n/config";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import { buildNameResolver } from "@/lib/knowledge/attribution";
import { projectTranscript } from "@/lib/knowledge/project-transcript";
import {
    inferSummarySpeakerNumberOffset,
    projectSummarySpeakerReferencesForExport,
} from "@/lib/knowledge/speaker-references";
import { correctionOverlay } from "@/lib/learn/llm-input";
import { sanitizeDownloadBasename } from "@/lib/recordings/filename";
import {
    reconcileRecordingStorage,
    recordingStorageNeedsReconciliation,
} from "@/lib/recordings/reconcile-storage";
import { sidecarKey } from "@/lib/recordings/storage-files";
import { createUserStorageProvider } from "@/lib/storage/factory";
import { tasksForArchive } from "@/lib/tasks/archive";
import {
    formatSpeakerLabel,
    parseSpeakerTurns,
} from "@/lib/transcription/diarization";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";
import type { SpeakerNameResolver } from "@/lib/transcription/turns";
import { resolvePrimaryTranscript } from "@/lib/v1/serialize";

const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

export type SidecarKind = "transcript" | "summary";

/** Which sidecars a call should write. Both false is a no-op. */
export interface SidecarSelection {
    transcript: boolean;
    summary: boolean;
}

export interface TranscriptSidecarInput {
    title: string;
    recordedAt: Date;
    durationMs: number;
    language: string | null;
    confirmedLanguage?: string | null;
    provider: string;
    model: string;
    source: string;
    text: string;
    participants: string[];
}

export interface SummarySidecarInput {
    title: string;
    recordedAt: Date;
    provider: string;
    model: string;
    source: string;
    transcriptSource: string;
    language?: string | null;
    confirmedLanguage?: string | null;
    summary: string | null;
    keyPoints: string[];
    actionItems: string[];
    /** The recording's tasks; when there are any they replace the action items. */
    tasks?: SummarySidecarTask[];
    participants: string[];
}

export interface SummarySidecarTask {
    text: string;
    done: boolean;
    assignee: string | null;
    dueDate: string | null;
    duePhrase?: string | null;
}

export interface RecordingMarkdownDocument {
    content: string;
    filename: string;
}

interface SidecarProjectionContext {
    primary: typeof transcriptions.$inferSelect | null;
    resolve: SpeakerNameResolver | undefined;
    participants: string[];
    speakers: string[];
    summaryLanguage: string | null;
}

export { sidecarKey } from "@/lib/recordings/storage-files";

/** Markdown document for a transcript, with YAML front matter. */
export function buildTranscriptMarkdown(input: TranscriptSidecarInput): string {
    const frontMatter = [
        "---",
        `title: ${yamlString(input.title)}`,
        `recorded: ${input.recordedAt.toISOString()}`,
        ...participantsFrontMatter(input.participants),
        `duration: ${formatDuration(input.durationMs)}`,
        `language: ${input.language ? yamlString(input.language) : "null"}`,
        `confirmed_language: ${input.confirmedLanguage ? yamlString(input.confirmedLanguage) : "null"}`,
        `source: ${yamlString(input.source)}`,
        `provider: ${yamlString(input.provider)}`,
        `model: ${yamlString(input.model)}`,
        "---",
    ].join("\n");

    return `${frontMatter}\n\n# ${input.title}\n\n${input.text.trim()}\n`;
}

/** Markdown document for a summary, with YAML front matter. */
export function buildSummaryMarkdown(input: SummarySidecarInput): string {
    const frontMatter = [
        "---",
        `title: ${yamlString(input.title)}`,
        `recorded: ${input.recordedAt.toISOString()}`,
        ...participantsFrontMatter(input.participants),
        `confirmed_language: ${input.confirmedLanguage ? yamlString(input.confirmedLanguage) : "null"}`,
        `source: ${yamlString(input.source)}`,
        `transcript_source: ${yamlString(input.transcriptSource)}`,
        `provider: ${yamlString(input.provider)}`,
        `model: ${yamlString(input.model)}`,
        "---",
    ].join("\n");

    const sections = [`# ${input.title}`, ...summarySections(input)];

    return `${frontMatter}\n\n${sections.join("\n\n")}\n`;
}

/**
 * A summary's Markdown sections: its text, key points, and its tasks (or,
 * while there are none, its action items).
 */
export function summarySections(
    input: Pick<
        SummarySidecarInput,
        "summary" | "keyPoints" | "actionItems" | "tasks" | "language"
    >,
): string[] {
    const sections: string[] = [];
    const locale = normalizeLocale(input.language) ?? defaultLocale;
    const summary = input.summary?.trim();
    if (summary) {
        sections.push(
            `## ${translatedSourceMessage(locale, "Summary")}\n\n${summary}`,
        );
    }
    if (input.keyPoints.length > 0) {
        sections.push(
            `## ${translatedSourceMessage(locale, "Key Points")}\n\n${bulletList(input.keyPoints)}`,
        );
    }
    if (input.tasks && input.tasks.length > 0) {
        sections.push(
            `## ${translatedSourceMessage(locale, "Tasks")}\n\n${taskList(input.tasks, locale)}`,
        );
    } else if (input.actionItems.length > 0) {
        sections.push(
            `## ${translatedSourceMessage(locale, "Action Items")}\n\n${bulletList(input.actionItems)}`,
        );
    }
    return sections;
}

function taskList(
    tasks: readonly SummarySidecarTask[],
    locale: AppLocale,
): string {
    const headers = ["Task", "Due", "Assignee"].map((header) =>
        translatedSourceMessage(locale, header),
    );
    const rows = tasks.map((task) => {
        const text = tableCell(task.text);
        return [
            task.done ? `~~${text}~~` : text,
            tableCell(task.dueDate ?? task.duePhrase ?? ""),
            tableCell(task.assignee ?? ""),
        ];
    });
    return [headers, ["---", "---", "---"], ...rows]
        .map((cells) => `| ${cells.join(" | ")} |`)
        .join("\n");
}

function tableCell(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\\", "&#92;")
        .replaceAll("|", "&#124;")
        .replace(/\r\n|\r|\n/g, "<br>")
        .trim();
}

/**
 * Write the requested sidecars for one recording and return the kinds that
 * were actually written. Kinds with no content yet (no transcript, no
 * summary) are skipped rather than written empty.
 *
 * Throws on storage failure; callers treat export as best-effort and must
 * not let a failure here roll back the transcript or summary itself.
 */
export async function exportRecordingSidecars(
    userId: string,
    recordingId: string,
    selection: SidecarSelection,
    source?: string,
): Promise<SidecarKind[]> {
    if (!selection.transcript && !selection.summary) return [];

    const [recording] = await db
        .select(audioItemColumns)
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);

    if (!recording) return [];

    const title = decryptText(recording.title);
    const written: SidecarKind[] = [];
    let storagePath = recording.storagePath;
    let storage: Awaited<ReturnType<typeof createUserStorageProvider>> | null =
        null;

    const storageState = {
        id: recording.id,
        userId,
        title,
        storagePath: recording.storagePath,
        storageFilename: recording.storageFilename,
    };
    if (recordingStorageNeedsReconciliation(storageState)) {
        const reconciled = await reconcileRecordingStorage({
            ...storageState,
        });
        storagePath = reconciled.storagePath;
    }

    const selectedKinds: SidecarKind[] = [
        ...(selection.transcript ? (["transcript"] as const) : []),
        ...(selection.summary ? (["summary"] as const) : []),
    ];
    for (const kind of selectedKinds) {
        const sources = source
            ? [source]
            : await contentSources(userId, recordingId, kind);
        for (const contentSource of sources) {
            const document = await renderRecordingMarkdownDocument(
                userId,
                recording,
                title,
                kind,
                storagePath,
                { source: contentSource },
            );
            if (!document) continue;

            storage ??= await createUserStorageProvider(userId);
            await storage.uploadFile(
                sidecarKey(storagePath, kind, contentSource),
                Buffer.from(document.content, "utf8"),
                MARKDOWN_CONTENT_TYPE,
            );
            written.push(kind);
        }
    }

    return written;
}

/** How a Markdown document is rendered for its reader. */
export interface RecordingMarkdownOptions {
    source?: string;
    /** Rendering for the Organization view: name Organization people only. */
    orgPeopleOnly?: boolean;
    /**
     * The sharing state the reader was authorized in; its corrections are
     * read only in that state (see `correctionOverlay`).
     */
    sharedAs?: boolean;
    /**
     * An export of the owner's own content: on a shared recording, only the
     * corrections the owner made.
     */
    ownerAuthoredOnly?: boolean;
}

/**
 * How a folder export renders a document: the Organization's view for the
 * organization account, the owner's own content for everyone else.
 */
export function folderExportDocumentOptions(
    source: string,
    organization: boolean,
): RecordingMarkdownOptions {
    return organization
        ? { source, orgPeopleOnly: true }
        : { source, ownerAuthoredOnly: true };
}

/**
 * Render a recording's transcript or summary as Markdown, from the rows its
 * owner holds: a shared recording is one recording.
 */
export async function getRecordingMarkdownDocument(
    ownerUserId: string,
    recordingId: string,
    kind: SidecarKind,
    options: RecordingMarkdownOptions = {},
): Promise<RecordingMarkdownDocument | null> {
    const [item] = await db
        .select({
            id: chatterItems.id,
            kind: chatterItems.kind,
            title: chatterItems.title,
            occurredAt: chatterItems.occurredAt,
        })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, recordingId),
                eq(chatterItems.userId, ownerUserId),
                isNull(chatterItems.deletedAt),
            ),
        )
        .limit(1);
    if (!item) return null;

    const title = decryptText(item.title);
    if (item.kind === "mail") {
        if (kind === "transcript") return null;
        return renderMailSummaryMarkdownDocument(
            ownerUserId,
            item,
            title,
            options,
        );
    }

    const [recording] = await db
        .select(audioItemColumns)
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, ownerUserId),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);
    if (!recording) return null;

    return renderRecordingMarkdownDocument(
        ownerUserId,
        recording,
        title,
        kind,
        recording.storagePath,
        options,
    );
}

async function renderMailSummaryMarkdownDocument(
    userId: string,
    item: {
        id: string;
        occurredAt: Date;
    },
    title: string,
    { source, ownerAuthoredOnly = false }: RecordingMarkdownOptions,
): Promise<RecordingMarkdownDocument | null> {
    const enhancements = await db
        .select()
        .from(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.itemId, item.id),
                eq(aiEnhancements.userId, userId),
            ),
        );
    const enhancement = source
        ? enhancements.find((candidate) => candidate.source === source)
        : await preferredEnhancement(userId, enhancements);
    if (!enhancement) return null;

    const [[content], [settings]] = await Promise.all([
        db
            .select({ language: mailContents.language })
            .from(mailContents)
            .where(
                and(
                    eq(mailContents.itemId, item.id),
                    eq(mailContents.userId, userId),
                ),
            )
            .limit(1),
        db
            .select({
                aiOutputLanguage: userSettings.aiOutputLanguage,
                defaultTranscriptionLanguage:
                    userSettings.defaultTranscriptionLanguage,
            })
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1),
    ]);
    const summary = decryptText(enhancement.summary) ?? null;
    const keyPoints = stringArray(
        decryptJsonField<unknown>(enhancement.keyPoints),
    );
    const actionItems = stringArray(
        decryptJsonField<unknown>(enhancement.actionItems),
    );
    const tasks = (
        (
            await tasksForArchive(
                ownerAuthoredOnly
                    ? { kind: "personal", userId }
                    : { kind: "owner", userId },
                [item.id],
            )
        ).get(item.id) ?? []
    )
        .filter((task) => task.status !== "dropped")
        .map((task) => ({
            text: task.text,
            done: task.status === "done",
            assignee: task.assignee?.name ?? task.assigneeHint,
            dueDate: task.dueDate,
            duePhrase: task.duePhrase,
        }));
    if (
        !summary?.trim() &&
        keyPoints.length === 0 &&
        actionItems.length === 0 &&
        tasks.length === 0
    ) {
        return null;
    }

    const basename = sanitizeDownloadBasename(title) || "untitled";
    const filename = sidecarKey(
        `${basename}.eml`,
        "summary",
        enhancement.source,
    )
        .split("/")
        .at(-1);
    if (!filename) return null;

    return {
        filename,
        content: buildSummaryMarkdown({
            title,
            recordedAt: item.occurredAt,
            provider: enhancement.provider,
            model: enhancement.model,
            source: enhancement.source,
            transcriptSource: "mail",
            language: resolveAiOutputLanguage(
                settings?.aiOutputLanguage,
                content?.language ?? settings?.defaultTranscriptionLanguage,
            ),
            summary,
            keyPoints,
            actionItems,
            tasks,
            participants: [],
        }),
    };
}

async function renderRecordingMarkdownDocument(
    userId: string,
    recording: AudioItemRow,
    title: string,
    kind: SidecarKind,
    storagePath: string,
    {
        source,
        orgPeopleOnly = false,
        sharedAs,
        ownerAuthoredOnly = false,
    }: RecordingMarkdownOptions = {},
): Promise<RecordingMarkdownDocument | null> {
    if (kind === "transcript") {
        const projection = await loadSidecarProjectionContext(
            userId,
            recording.id,
            source,
            undefined,
            orgPeopleOnly,
        );
        const { primary } = projection;
        if (!primary) return null;
        const filename = sidecarKey(storagePath, kind, primary.source)
            .split("/")
            .at(-1);
        if (!filename) return null;

        // As people read it: its confirmed corrections applied (a review
        // not yet finished is not in a document).
        const corrections = await correctionOverlay(
            {
                id: primary.id,
                userId: primary.userId,
                recordingId: recording.id,
                revision: primary.revision,
            },
            { pending: false, sharedAs, ownerAuthoredOnly },
        );
        const text = projectTranscript(
            {
                id: primary.id,
                text: decryptText(primary.text),
                turns: primary.turns,
            },
            projection.resolve,
            corrections,
        );
        if (!text?.trim()) return null;

        return {
            filename,
            content: buildTranscriptMarkdown({
                title,
                recordedAt: recording.occurredAt,
                durationMs: recording.duration,
                language: primary.detectedLanguage,
                confirmedLanguage: recording.confirmedLanguage,
                provider: primary.provider,
                model: primary.model,
                source: primary.source,
                text,
                participants: projection.participants,
            }),
        };
    }

    const enhancements = await db
        .select()
        .from(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.itemId, recording.id),
                eq(aiEnhancements.userId, userId),
            ),
        );
    const enhancement = source
        ? enhancements.find((candidate) => candidate.source === source)
        : await preferredEnhancement(userId, enhancements);
    if (!enhancement) return null;

    const projection = await loadSidecarProjectionContext(
        userId,
        recording.id,
        enhancement.source,
        enhancement.transcriptionId,
        orgPeopleOnly,
    );
    const filename = sidecarKey(storagePath, kind, enhancement.source)
        .split("/")
        .at(-1);
    if (!filename) return null;

    const summaryValue = decryptText(enhancement.summary) ?? null;
    const keyPointValues = stringArray(
        decryptJsonField<unknown>(enhancement.keyPoints),
    );
    const actionItemValues = stringArray(
        decryptJsonField<unknown>(enhancement.actionItems),
    );
    const speakerNumberOffset = inferSummarySpeakerNumberOffset(
        [summaryValue ?? "", ...keyPointValues, ...actionItemValues].join("\n"),
        projection.speakers,
    );
    const summary = summaryValue
        ? projectSummarySpeakerReferencesForExport(
              summaryValue,
              projection.resolve,
              speakerNumberOffset,
          )
        : null;
    const keyPoints = keyPointValues.map((item) =>
        projectSummarySpeakerReferencesForExport(
            item,
            projection.resolve,
            speakerNumberOffset,
        ),
    );
    const actionItems = actionItemValues.map((item) =>
        projectSummarySpeakerReferencesForExport(
            item,
            projection.resolve,
            speakerNumberOffset,
        ),
    );
    const tasks = (
        (
            await tasksForArchive(
                ownerAuthoredOnly
                    ? { kind: "personal", userId }
                    : { kind: "owner", userId },
                [recording.id],
            )
        ).get(recording.id) ?? []
    )
        .filter((task) => task.status !== "dropped")
        .map((task) => ({
            text: task.text,
            done: task.status === "done",
            assignee: task.assignee?.name ?? task.assigneeHint,
            dueDate: task.dueDate,
            duePhrase: task.duePhrase,
        }));
    if (
        !summary?.trim() &&
        keyPoints.length === 0 &&
        actionItems.length === 0 &&
        tasks.length === 0
    ) {
        return null;
    }

    return {
        filename,
        content: buildSummaryMarkdown({
            title,
            recordedAt: recording.occurredAt,
            provider: enhancement.provider,
            model: enhancement.model,
            source: enhancement.source,
            transcriptSource: projection.primary?.source ?? enhancement.source,
            language:
                enhancement.outputLanguage ??
                recording.confirmedLanguage ??
                projection.summaryLanguage,
            confirmedLanguage: recording.confirmedLanguage,
            summary,
            keyPoints,
            actionItems,
            tasks,
            participants: projection.participants,
        }),
    };
}

async function loadSidecarProjectionContext(
    userId: string,
    recordingId: string,
    source?: string,
    transcriptionId?: string | null,
    orgPeopleOnly = false,
): Promise<SidecarProjectionContext> {
    const rows = await db
        .select()
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, userId),
            ),
        );
    const [settings] = await db
        .select({
            preferred: userSettings.preferredTranscriptSource,
            aiOutputLanguage: userSettings.aiOutputLanguage,
            defaultTranscriptionLanguage:
                userSettings.defaultTranscriptionLanguage,
        })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);

    const primary =
        (transcriptionId
            ? rows.find((transcript) => transcript.id === transcriptionId)
            : undefined) ??
        (source
            ? rows.find((transcript) => transcript.source === source)
            : resolvePrimaryTranscript(rows, settings?.preferred ?? "plaud")) ??
        null;
    const resolve = primary
        ? await buildNameResolver(primary.userId, primary.id, {
              orgPeopleOnly,
          })
        : undefined;
    const speakers = primary ? transcriptSpeakerLabels(primary) : [];
    return {
        primary,
        resolve,
        participants: participantNames(speakers, resolve),
        speakers,
        summaryLanguage: resolveAiOutputLanguage(
            settings?.aiOutputLanguage,
            primary?.detectedLanguage ?? settings?.defaultTranscriptionLanguage,
        ),
    };
}

/** Rewrite only sidecars that already exist for this recording. */
export async function rewriteExistingRecordingSidecars(
    userId: string,
    _recordingId: string,
): Promise<void> {
    await enqueueExportPlansForUser(userId);
}

/** Best-effort wrapper for user-facing mutation and attribution paths. */
export async function refreshExistingRecordingSidecars(
    userId: string,
    recordingId: string,
): Promise<void> {
    try {
        await rewriteExistingRecordingSidecars(userId, recordingId);
    } catch (error) {
        console.error(
            `Failed to refresh document sidecars for recording ${recordingId}:`,
            error,
        );
    }
}

/** Best-effort removal of one source-specific sidecar after content deletion. */
export async function removeRecordingSidecar(
    userId: string,
    _recordingId: string,
    _kind: SidecarKind,
    _source: string,
): Promise<void> {
    try {
        await enqueueExportPlansForUser(userId);
    } catch (error) {
        console.error("Failed to schedule folder export projection:", error);
    }
}

/**
 * Best-effort variant used by the transcription and summary pipelines.
 * Reads the user's toggles, writes what they asked for, and swallows any
 * failure so a storage problem never costs the user their transcript.
 */
export async function exportRecordingSidecarsIfEnabled(
    userId: string,
    _recordingId: string,
    _kind: SidecarKind,
    _source?: string,
): Promise<void> {
    try {
        await enqueueExportPlansForUser(userId);
    } catch (error) {
        console.error("Failed to schedule folder export projection:", error);
    }
}

async function contentSources(
    userId: string,
    recordingId: string,
    kind: SidecarKind,
): Promise<string[]> {
    const rows =
        kind === "transcript"
            ? await db
                  .select({ source: transcriptions.source })
                  .from(transcriptions)
                  .where(
                      and(
                          eq(transcriptions.recordingId, recordingId),
                          eq(transcriptions.userId, userId),
                      ),
                  )
            : await db
                  .select({ source: aiEnhancements.source })
                  .from(aiEnhancements)
                  .where(
                      and(
                          eq(aiEnhancements.itemId, recordingId),
                          eq(aiEnhancements.userId, userId),
                      ),
                  );
    return [...new Set(rows.map((row) => row.source))];
}

async function preferredEnhancement(
    userId: string,
    enhancements: Array<typeof aiEnhancements.$inferSelect>,
): Promise<typeof aiEnhancements.$inferSelect | undefined> {
    const [settings] = await db
        .select({ preferred: userSettings.preferredTranscriptSource })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);
    const preferred = settings?.preferred ?? "plaud";
    return (
        enhancements.find((enhancement) => enhancement.source === preferred) ??
        enhancements.find((enhancement) => enhancement.source === "riffado") ??
        enhancements[0]
    );
}

function bulletList(items: string[]): string {
    return items.map((item) => `- ${item}`).join("\n");
}

function stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string");
}

function yamlString(value: string): string {
    return JSON.stringify(value);
}

function participantsFrontMatter(participants: string[]): string[] {
    if (participants.length === 0) return ["participants: []"];
    return [
        "participants:",
        ...participants.map((participant) => `  - ${yamlString(participant)}`),
    ];
}

function participantNames(
    labels: readonly string[],
    resolve: SpeakerNameResolver | undefined,
): string[] {
    const names: string[] = [];

    for (const label of labels) {
        const name = resolve?.(label) ?? formatSpeakerLabel(label);
        if (name && !names.includes(name)) names.push(name);
    }
    return names;
}

function transcriptSpeakerLabels(
    transcript: typeof transcriptions.$inferSelect,
): string[] {
    const storedTurns = readTranscriptTurns(transcript);
    const parsedTurns = storedTurns
        ? null
        : parseSpeakerTurns(decryptText(transcript.text));
    return storedTurns
        ? storedTurns.map((turn) => turn.speaker)
        : (parsedTurns?.map((turn) => turn.speaker) ?? []);
}

function formatDuration(durationMs: number): string {
    const total = Math.max(0, Math.round(durationMs / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return [hours, minutes, seconds]
        .map((part) => String(part).padStart(2, "0"))
        .join(":");
}
