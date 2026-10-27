import { eq } from "drizzle-orm";
import type * as OpenAIModule from "openai";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import {
    agendaPoints,
    agendaSuggestions,
    agendaTasks,
    aiEnhancements,
    aiUsageEvents,
    apiCredentials,
    asyncJobs,
    chatterItems,
    folderDefaultProfiles,
    meetingAgendas,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    recordingTasks,
    taskMentions,
    taskStatusTransitions,
    users,
} from "@/db/schema";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { seededAudioProfileSettings } from "@/tests/profiles/seeded-profile-fixture";

const { ref, proxy, complete } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        ref,
        complete: vi.fn(),
        proxy: new Proxy(
            {},
            {
                get(_target, key) {
                    if (!ref.current) throw new Error("Database not ready");
                    const value = ref.current[key];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
    };
});
vi.mock("@/db", () => ({ db: proxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "agenda-pipeline-test",
        AUTHZ_MODE: "local",
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => null,
    isOrgAccount: async () => false,
    isOrgScopeVisible: () => false,
    isOrgScopeEnabled: () => false,
    assertOrgScopeWritable: () => undefined,
    assertNotOrgAccount: async () => undefined,
}));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: async () => false,
    actsForOrganization: async () => false,
}));
vi.mock("@/lib/knowledge/embeddings", () => ({ embeddingClient: () => null }));
vi.mock("@/lib/mail/redact", () => ({
    secretAddressMasker: async () => (text: string) => text,
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: async () => undefined,
}));
vi.mock("openai", async (importOriginal) => ({
    ...(await importOriginal<typeof OpenAIModule>()),
    OpenAI: class {
        chat = { completions: { create: complete } };
    },
}));

import { db } from "@/db";
import { writeSummaryAgenda } from "@/db/queries/agenda-pipeline";
import { agendaSuggestionInputs } from "@/db/queries/agenda-suggestions";
import { claimDueJobs, enqueueJob } from "@/db/queries/async-jobs";
import { loadStatistics } from "@/db/queries/statistics";
import { encrypt } from "@/lib/encryption";
import {
    decryptJsonField,
    decryptText,
    encryptText,
} from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import {
    agendaPlanBlock,
    agendaSpellingTerms,
    loadRecordingAgenda,
} from "@/lib/meetings/pipeline-context";
import {
    changePoint,
    getMeeting,
    prepareMeeting,
} from "@/lib/meetings/service";
import {
    agendaSuggestionsJobHandler,
    enqueueAgendaSuggestions,
} from "@/lib/meetings/suggestions-job";
import { agendaSuggestionsAvailability } from "@/lib/meetings/suggestions-provider";
import { metricIndex } from "@/lib/statistics/data";
import { taskViewerById } from "@/lib/tasks/access";
import { loadTasksPromptContext } from "@/lib/tasks/proposals";
import { upsertEnhancement } from "@/lib/transcription/persist";

const databaseUrl = getTestDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const start = new Date("2026-10-20T10:00:00Z");
const end = new Date("2026-10-20T11:00:00Z");

suite("meeting processing pipeline (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            databaseUrl ?? "",
            "meeting_pipeline",
        );
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        ref.current = null;
        await database?.dispose();
    });
    async function recording(id: string, userId = "owner") {
        await insertRecordings(database.db, {
            id,
            userId,
            filename: encryptText("Acme recording"),
            startTime: start,
            endTime: end,
            duration: 3_600_000,
            filesize: 1,
            fileMd5: "a".repeat(32),
            storageType: "local",
            storagePath: `${id}.ogg`,
            deviceSn: "test",
            plaudFileId: id,
            plaudVersion: "1",
        });
    }
    beforeEach(async () => {
        complete.mockReset();
        await db.delete(users);
        await db.insert(users).values([
            { id: "owner", email: "owner@example.com", uiLocale: "cs-CZ" },
            { id: "other", email: "other@example.com" },
        ]);
        await db.insert(recordingFolders).values([
            {
                id: "root",
                userId: "owner",
                parentId: null,
                kind: "private",
                name: encryptText("Root"),
                nameHash: lookupHash("Root"),
            },
            {
                id: "folder",
                userId: "owner",
                parentId: "root",
                kind: "custom",
                name: encryptText("Acme"),
                nameHash: lookupHash("Acme"),
            },
        ]);
        await recording("recording");
        await recording("previous");
        await db.insert(chatterItems).values({
            id: "meeting",
            userId: "owner",
            kind: "meeting",
            title: encryptText("Acme meeting"),
            occurredAt: start,
            deletedAt: end,
        });
        await db.insert(meetingAgendas).values({
            id: "agenda",
            userId: "owner",
            meetingItemId: "meeting",
            recordingItemId: "recording",
            plannedStart: start,
            plannedEnd: end,
            liveStartedAt: start,
            liveEndedAt: end,
            absorbedAt: end,
            state: "held",
            calendarEventId: "explicit-event",
            calendarSeriesId: "series",
        });
        await db.insert(recordingFolderAssignments).values(
            ["meeting", "recording", "previous"].map((itemId) => ({
                userId: "owner",
                itemId,
                folderId: "folder",
                createdAt: new Date("2026-10-21T10:00:00Z"),
            })),
        );
        await db.insert(agendaPoints).values([
            {
                id: "p1",
                userId: "owner",
                agendaId: "agenda",
                text: encryptText("Acme roadmap"),
                discussedAt: start,
            },
            {
                id: "p2",
                userId: "owner",
                agendaId: "agenda",
                parentId: "p1",
                text: encryptText("Jitka Dvořáková"),
                position: 1,
                note: encryptText("Only a hint"),
            },
        ]);
    });
    const write = (version = 0, covered = ["p2"]) =>
        upsertEnhancement({
            userId: "owner",
            recordingId: "recording",
            transcriptionId: null,
            summary: "### Agenda\n\nAcme",
            keyPoints: [],
            actionItems: [],
            source: "riffado",
            provider: "test",
            model: "test",
            pipeline: "legacy",
            agenda: {
                id: "agenda",
                userId: "owner",
                version,
                outcome: {
                    covered,
                    notCovered: [],
                    unplanned: ["Unplanned topic"],
                },
            },
        });
    async function standalone() {
        await db
            .update(meetingAgendas)
            .set({ recordingItemId: null, absorbedAt: null, state: "planned" })
            .where(eq(meetingAgendas.id, "agenda"));
        await db
            .update(chatterItems)
            .set({ deletedAt: null })
            .where(eq(chatterItems.id, "meeting"));
    }
    async function provider() {
        const settings = seededAudioProfileSettings();
        settings.steps.summary.provider = {
            credentialId: "folder-provider",
            scope: "personal",
        };
        await db.insert(apiCredentials).values({
            id: "folder-provider",
            userId: "owner",
            provider: "Custom",
            apiKey: encrypt("test-key"),
            defaultModel: "local-model",
            baseUrl: "http://localhost:1234/v1",
        });
        await db.insert(processingProfiles).values({
            id: "profile",
            ownerUserId: "owner",
            scope: "personal",
            channel: "audio",
            name: encryptText("Acme profile"),
            currentRevisionId: "revision",
        });
        await db.insert(processingProfileRevisions).values({
            id: "revision",
            profileId: "profile",
            settings: encryptText(JSON.stringify(settings)),
        });
        await db.insert(folderDefaultProfiles).values({
            folderId: "folder",
            channel: "audio",
            profileId: "profile",
        });
    }
    async function task(id: string, position: number, changed = false) {
        await db.insert(recordingTasks).values({
            id,
            userId: "owner",
            itemId: "previous",
            status: changed ? "done" : "open",
            text: encryptText(id),
            source: "manual",
            statusChangedAt: changed ? new Date("2026-10-20T10:30:00Z") : null,
        });
        await db.insert(taskMentions).values({
            taskId: id,
            userId: "owner",
            itemId: "previous",
            view: "private",
            matchDecision: "home",
            statementAt: start,
        });
        if (position >= 0)
            await db.insert(agendaTasks).values({
                agendaId: "agenda",
                userId: "owner",
                taskId: id,
                position,
                origin: "last_meeting",
            });
    }
    it("reads a decrypted plan, preserves its explicit event, and refuses invisible recordings", async () => {
        const agenda = await loadRecordingAgenda("owner", "recording");
        expect(agenda?.calendarEventId).toBe("explicit-event");
        expect(agenda?.points[1]).toMatchObject({
            parentId: "p1",
            text: "Jitka Dvořáková",
            note: "Only a hint",
        });
        expect(agendaSpellingTerms(agenda)).toContain("Dvořáková");
        expect(await loadRecordingAgenda("other", "recording")).toBeNull();
        expect(await loadRecordingAgenda("owner", "previous")).toBeNull();
    });
    it("stores encrypted outcomes with the summary and overwrites all prior classifications", async () => {
        expect(await write()).toEqual({ committed: true });
        const [agenda] = await db.select().from(meetingAgendas);
        expect(decryptJsonField(agenda.outcomeUnplanned)).toEqual([
            "Unplanned topic",
        ]);
        expect(JSON.stringify(agenda.outcomeUnplanned)).not.toContain(
            "Unplanned",
        );
        const [summary] = await db.select().from(aiEnhancements);
        expect(agenda.outcomeSummaryId).toBe(summary.id);
        expect(
            (
                await db
                    .select()
                    .from(agendaPoints)
                    .where(eq(agendaPoints.id, "p1"))
            )[0].summaryOutcome,
        ).toBe("not_covered");
        expect(await write(1, ["p1", "foreign"])).toEqual({ committed: true });
        expect(
            (
                await db
                    .select()
                    .from(agendaPoints)
                    .where(eq(agendaPoints.id, "p2"))
            )[0].summaryOutcome,
        ).toBe("not_covered");
    });
    it("does not write a summary or outcomes after the plan is detached or changed", async () => {
        await db
            .update(meetingAgendas)
            .set({ recordingItemId: null })
            .where(eq(meetingAgendas.id, "agenda"));
        expect(await write()).toEqual({ committed: false, reason: "outdated" });
        expect(await db.select().from(aiEnhancements)).toHaveLength(0);
    });
    it("prioritizes agenda tasks in review order and suppresses tasks changed live", async () => {
        await task("ranked roadmap", -1);
        await task("second reviewed", 1);
        await task("first reviewed", 0);
        await task("already closed", 2, true);
        await task("changed then reopened", 3);
        await db.insert(taskStatusTransitions).values({
            taskId: "changed then reopened",
            actorUserId: "owner",
            fromStatus: "open",
            toStatus: "done",
            createdAt: new Date("2026-10-20T10:30:00Z"),
        });
        const agenda = await loadRecordingAgenda("owner", "recording");
        const context = await loadTasksPromptContext({
            recording: {
                id: "recording",
                userId: "owner",
                occurredAt: start,
                timezone: null,
                zonemins: null,
            },
            transcriptionId: null,
            orgView: false,
            reviewer: await taskViewerById("owner"),
            itemText: "ranked roadmap",
            agendaTasks: agenda?.tasks,
        });
        expect([...context.refs.values()].slice(0, 2)).toEqual([
            "first reviewed",
            "second reviewed",
        ]);
        expect([...context.refs.values()]).not.toContain("already closed");
        expect([...context.refs.values()]).not.toContain(
            "changed then reopened",
        );
        expect(context.text).toContain("Already decided");
        expect(
            agenda?.tasks.find((task) => task.id === "already closed")
                ?.changedDuringMeeting,
        ).toBe(true);
    });
    it("offers transcript-uncovered points as carry-over suggestions without adding them", async () => {
        await write();
        const next = await prepareMeeting("owner", {
            folderId: "folder",
            title: "Next",
            start: "2026-10-28T10:00:00Z",
        });
        const suggestions = await db
            .select()
            .from(agendaSuggestions)
            .where(eq(agendaSuggestions.agendaId, next.id));
        expect(suggestions.map((row) => row.originPointId)).toEqual(["p1"]);
        expect(
            await db
                .select()
                .from(agendaPoints)
                .where(eq(agendaPoints.agendaId, next.id)),
        ).toHaveLength(0);
    });
    it("uses folder arrivals, visible summaries and open tasks, with no transcript input", async () => {
        await standalone();
        await task("review", -1);
        await recording("hidden", "other");
        await db
            .insert(recordingFolderAssignments)
            .values({ itemId: "hidden", userId: "other", folderId: "folder" });
        await db.insert(aiEnhancements).values(
            ["previous", "hidden"].map((itemId) => ({
                itemId,
                userId: itemId === "hidden" ? "other" : "owner",
                source: "riffado" as const,
                provider: "test",
                model: "test",
                summary: encryptText("Earlier Acme summary"),
            })),
        );
        await db.insert(aiEnhancements).values({
            itemId: "previous",
            userId: "owner",
            source: "plaud",
            provider: "test",
            model: "test",
            summary: encryptText("Older imported summary"),
        });
        const [agenda] = await db.select().from(meetingAgendas);
        const inputs = await agendaSuggestionInputs({
            agenda,
            folderId: "folder",
            userId: "owner",
            orgUserId: null,
            viewer: await taskViewerById("owner"),
        });
        expect(inputs.summaries.map((row) => row.itemId)).toEqual(["previous"]);
        expect(decryptText(inputs.summaries[0].summary ?? "")).toBe(
            "Earlier Acme summary",
        );
        expect(inputs.tasks.map((row) => row.id)).toEqual(["review"]);
    });
    it("uses a prior series recording without an agenda as the arrival cutoff", async () => {
        await standalone();
        await db
            .update(recordings)
            .set({ calendarSeriesId: "series" })
            .where(eq(recordings.id, "previous"));
        await db
            .update(chatterItems)
            .set({ occurredAt: new Date("2026-10-10T10:00:00Z") })
            .where(eq(chatterItems.id, "previous"));
        await db.insert(aiEnhancements).values(
            ["previous", "recording"].map((itemId) => ({
                itemId,
                userId: "owner",
                source: "riffado" as const,
                provider: "test",
                model: "test",
                summary: encryptText(itemId),
            })),
        );
        await db
            .update(recordingFolderAssignments)
            .set({ createdAt: new Date("2026-10-09T10:00:00Z") })
            .where(eq(recordingFolderAssignments.itemId, "previous"));
        const [agenda] = await db.select().from(meetingAgendas);
        const inputs = await agendaSuggestionInputs({
            agenda,
            folderId: "folder",
            userId: "owner",
            orgUserId: null,
            viewer: await taskViewerById("owner"),
        });
        expect(inputs.summaries.map((row) => row.itemId)).toEqual([
            "recording",
        ]);
    });
    it("fails clearly without a provider and does not queue a paid job", async () => {
        await standalone();
        expect(
            await agendaSuggestionsAvailability("owner", "agenda"),
        ).toMatchObject({ available: false });
        await expect(
            enqueueAgendaSuggestions("owner", "agenda"),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(complete).not.toHaveBeenCalled();
    });
    it("queues one durable suggestions job for repeated requests", async () => {
        await standalone();
        await provider();
        const first = await enqueueAgendaSuggestions("owner", "agenda");
        const second = await enqueueAgendaSuggestions("owner", "agenda");
        expect(first).toMatchObject({ available: true });
        expect(second.jobId).toBe(first.jobId);
        expect(await db.select().from(asyncJobs)).toMatchObject([
            {
                kind: "agenda.suggestions",
                subjectId: "agenda",
                status: "pending",
                maxAttempts: 3,
                payload: { agendaId: "agenda" },
            },
        ]);
        expect(complete).not.toHaveBeenCalled();
    });
    it("claims at most one suggestions job per user across workers", async () => {
        for (const [userId, subjectId] of [
            ["owner", "one"],
            ["owner", "two"],
            ["other", "three"],
        ]) {
            await enqueueJob({
                userId,
                kind: "agenda.suggestions",
                subjectId,
                payload: { agendaId: subjectId },
            });
        }
        const claimed = await claimDueJobs("agenda.suggestions", 10);
        expect(claimed).toHaveLength(2);
        expect(new Set(claimed.map((job) => job.userId))).toEqual(
            new Set(["owner", "other"]),
        );
        expect(await claimDueJobs("agenda.suggestions", 10)).toEqual([]);
    });
    it("refuses a missing pinned provider instead of using another configured card", async () => {
        await standalone();
        await provider();
        await db.delete(apiCredentials);
        await db.insert(apiCredentials).values({
            id: "other-provider",
            userId: "owner",
            provider: "Custom",
            apiKey: encrypt("test-key"),
            defaultModel: "other-model",
        });
        expect(
            await agendaSuggestionsAvailability("owner", "agenda"),
        ).toMatchObject({ available: false, errorCode: "NOT_FOUND" });
        await expect(
            enqueueAgendaSuggestions("owner", "agenda"),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(await db.select().from(asyncJobs)).toHaveLength(0);
    });
    it("disables suggestions when the chosen card has no Default Model", async () => {
        await standalone();
        await provider();
        await db.update(apiCredentials).set({ defaultModel: null });
        expect(
            await agendaSuggestionsAvailability("owner", "agenda"),
        ).toMatchObject({
            available: false,
            errorCode: "AI_PROVIDER_NOT_CONFIGURED",
        });
    });
    it("runs the folder's pinned model, validates sources, preserves dismissals and records usage", async () => {
        await standalone();
        await provider();
        await task("open-task", -1);
        await db.insert(agendaSuggestions).values({
            userId: "owner",
            agendaId: "agenda",
            kind: "ai",
            text: encryptText("Dismissed point"),
            sources: { itemIds: [], taskIds: ["open-task"] },
            state: "dismissed",
        });
        complete.mockResolvedValue({
            choices: [
                {
                    message: {
                        content: JSON.stringify({
                            suggestions: [
                                {
                                    text: "Check Acme progress",
                                    parentPointId: "p1",
                                    sources: {
                                        itemIds: [],
                                        taskIds: ["open-task"],
                                    },
                                },
                                {
                                    text: "Dismissed point",
                                    sources: {
                                        itemIds: [],
                                        taskIds: ["open-task"],
                                    },
                                },
                                {
                                    text: "Invented source",
                                    sources: {
                                        itemIds: ["hidden"],
                                        taskIds: [],
                                    },
                                },
                            ],
                        }),
                    },
                },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
        });
        const result = await agendaSuggestionsJobHandler.run({
            userId: "owner",
            payload: { agendaId: "agenda" },
            jobId: "test",
            attempt: 1,
            maxAttempts: 3,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        expect(result).toEqual({ count: 1 });
        expect(complete.mock.calls[0][0].model).toBe("local-model");
        expect(JSON.stringify(complete.mock.calls[0][0])).not.toContain(
            "transcriptions",
        );
        const rows = await db.select().from(agendaSuggestions);
        expect(rows).toHaveLength(2);
        expect(
            decryptText(rows.find((row) => row.state === "open")?.text ?? ""),
        ).toBe("Check Acme progress");
        expect(rows.find((row) => row.state === "open")?.parentPointId).toBe(
            "p1",
        );
        expect(await db.select().from(agendaPoints)).toHaveLength(2);
        expect(await db.select().from(aiUsageEvents)).toMatchObject([
            {
                operation: "topics",
                model: "local-model",
                inputTokens: 100,
                outputTokens: 50,
            },
        ]);
        await db
            .update(apiCredentials)
            .set({ disabledAt: new Date() })
            .where(eq(apiCredentials.id, "folder-provider"));
        expect(
            await agendaSuggestionsAvailability("owner", "agenda"),
        ).toMatchObject({ available: false, errorCode: "CONFLICT" });
    });
    it("keeps owner-only agenda task text out of Organization candidates, decided tasks and the plan", async () => {
        await task("Owner-only agenda task", 0);
        await task("Owner-only decided task", 1, true);
        const agenda = await loadRecordingAgenda("owner", "recording");
        const context = await loadTasksPromptContext({
            recording: {
                id: "recording",
                userId: "owner",
                occurredAt: start,
                timezone: null,
                zonemins: null,
            },
            transcriptionId: null,
            orgView: true,
            reviewer: await taskViewerById("other"),
            agendaTasks: agenda?.tasks,
        });
        expect(context.refs.size).toBe(0);
        expect(context.text).not.toContain("Owner-only");
        expect(
            agendaPlanBlock(
                agenda
                    ? { ...agenda, tasks: [...(context.agendaTasks ?? [])] }
                    : null,
            ),
        ).not.toContain("Owner-only");
    });
    it("preserves the last outcome when a later summary omits agendaOutcome", async () => {
        await write();
        const [before] = await db.select().from(meetingAgendas);
        await db.transaction((tx) =>
            writeSummaryAgenda(
                tx,
                {
                    id: before.id,
                    userId: before.userId,
                    version: before.version,
                    outcome: null,
                },
                "unused",
            ),
        );
        const [after] = await db.select().from(meetingAgendas);
        expect(after).toEqual(before);
        expect(
            (
                await db
                    .select()
                    .from(agendaPoints)
                    .where(eq(agendaPoints.id, "p2"))
            )[0].summaryOutcome,
        ).toBe("covered");
    });
    it("commits paid suggestions after a concurrent tick, deduplicating new points and repairing removed parents", async () => {
        await standalone();
        await provider();
        await task("open-task", -1);
        complete.mockImplementation(async () => {
            await changePoint("owner", "agenda", "p1", {
                version: 0,
                discussed: true,
            });
            await db.delete(agendaPoints).where(eq(agendaPoints.id, "p2"));
            await db.insert(agendaPoints).values({
                userId: "owner",
                agendaId: "agenda",
                text: encryptText("Already added"),
                authorUserId: "owner",
            });
            return {
                choices: [
                    {
                        message: {
                            content: JSON.stringify({
                                suggestions: [
                                    {
                                        text: "New suggestion",
                                        parentPointId: "p2",
                                        sources: {
                                            itemIds: [],
                                            taskIds: ["open-task"],
                                        },
                                    },
                                    {
                                        text: "Already added",
                                        sources: {
                                            itemIds: [],
                                            taskIds: ["open-task"],
                                        },
                                    },
                                ],
                            }),
                        },
                    },
                ],
                usage: { prompt_tokens: 100, completion_tokens: 50 },
            };
        });
        expect(
            await agendaSuggestionsJobHandler.run({
                userId: "owner",
                payload: { agendaId: "agenda" },
                jobId: "test",
                attempt: 1,
                maxAttempts: 3,
                signal: new AbortController().signal,
                reportProgress: vi.fn(),
            }),
        ).toEqual({ count: 1 });
        const suggestions = await db.select().from(agendaSuggestions);
        expect(suggestions).toHaveLength(1);
        expect(decryptText(suggestions[0].text)).toBe("New suggestion");
        expect(suggestions[0].parentPointId).toBeNull();
    });
    it.each([
        "pending",
        "processing",
        "failed",
    ] as const)("exposes durable suggestions state %s and invalidates the polling cursor", async (status) => {
        await standalone();
        const before = await getMeeting("owner", "agenda");
        await db.insert(asyncJobs).values({
            userId: "owner",
            kind: "agenda.suggestions",
            subjectId: "agenda",
            status,
            payload: { agendaId: "agenda" },
            errorCode: status === "failed" ? "AI_PROVIDER_API_ERROR" : null,
        });
        const after = await getMeeting("owner", "agenda", before.cursor);
        expect(after).toMatchObject({
            unchanged: false,
            aiSuggestions: {
                job: {
                    state:
                        status === "pending"
                            ? "queued"
                            : status === "processing"
                              ? "running"
                              : "failed",
                },
            },
        });
        if (!after.unchanged && status === "failed")
            expect(after.aiSuggestions.job.errorCode).toBe(
                "AI_PROVIDER_API_ERROR",
            );
    });
    it("keeps suggestion usage counted after absorption without counting a summary activity", async () => {
        await db.insert(aiUsageEvents).values({
            itemId: "meeting",
            userId: "owner",
            actorUserId: "owner",
            payerUserId: "owner",
            operation: "topics",
            provider: "test",
            model: "test",
            costUsd: "0.25",
        });
        const stats = await loadStatistics("owner", "mine", "UTC");
        expect(
            stats.daily[metricIndex.summaries].every((count) => count === 0),
        ).toBe(true);
        expect(
            stats.daily[metricIndex.topicsCost].reduce(
                (sum, value) => sum + value,
                0,
            ),
        ).toBe(0.25);
        expect(stats.modelDays.reduce((sum, row) => sum + row[3], 0)).toBe(1);
        expect(stats.modelDays.reduce((sum, row) => sum + row[4], 0)).toBe(
            0.25,
        );
    });
});
