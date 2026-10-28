import type { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import unzipper from "unzipper";
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
    aiEnhancements,
    aiUsageEvents,
    asyncJobs,
    chatterItems,
    itemShares,
    mailContents,
    mailMessages,
    people,
    recordingFolderAssignments,
    recordingFolders,
    recordingTaskRejections,
    recordingTasks,
    summaryRemarks,
    transcriptions,
    transcriptSpeakers,
    userSettings,
    users,
} from "@/db/schema";
import type { StorageProvider } from "@/lib/storage/types";
import type { TaskProposals } from "@/lib/tasks/store";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const mocks = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        ref,
        db: new Proxy(
            {},
            {
                get: (_target, property) => {
                    if (!ref.current)
                        throw new Error("test database not ready");
                    const value = ref.current[property];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
        actor: "owner",
        reading: "current-reading",
        org: null as string | null,
        kind: "audio" as "audio" | "mail",
        completion: vi.fn(),
        taskProposals: vi.fn<() => Promise<TaskProposals | undefined>>(),
        sidecars: vi.fn(),
        removeSidecar: vi.fn(),
    };
});

vi.mock("@/db", () => ({ db: mocks.db, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "local",
        DATABASE_URL: "postgres://unused",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "summary-remarks-test-secret",
        AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 100,
        ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR: 100,
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => mocks.org,
    isOrgScopeEnabled: () => mocks.org !== null,
    isOrgScopeVisible: () => mocks.org !== null,
    assertOrgScopeWritable: () => {},
    isOrgAccount: async (id: string) => id === mocks.org,
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: mocks.actor } }),
    requireApiSessionActor: async () => ({
        session: { user: { id: mocks.actor } },
        actor: {},
    }),
}));
vi.mock("@/lib/authz/curator", () => ({
    actsForOrganization: async () =>
        mocks.actor === mocks.org || mocks.actor === "curator",
    userCuratesOrganizationNow: async () =>
        mocks.actor === mocks.org || mocks.actor === "curator",
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: async () => new ArchiveStorage(),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/sharing/notify", () => ({ notifyIfShared: vi.fn() }));
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: mocks.sidecars,
    removeRecordingSidecar: mocks.removeSidecar,
}));
vi.mock("@/lib/profiles/resolve", () => ({
    resolveItemProfile: async () => testProfile(),
    resolveSelectedProfile: async () => testProfile(),
    loadSelectedProfileRevision: async () => testProfile(),
}));
vi.mock("@/lib/profiles/resolve-manual", () => ({
    resolveManualItemProfile: async () => testProfile(),
}));
vi.mock("@/lib/learn/llm-input", () => ({
    modelInput: async (transcript: { text: string }) => ({
        text: decryptText(transcript.text),
        turns: null,
        fingerprint: mocks.reading,
    }),
    llmRendering: async () => ({ fingerprint: mocks.reading }),
}));
vi.mock("@/lib/tasks/proposals", () => ({
    loadTasksPromptContext: async () => ({ text: "", refs: new Map() }),
    resolveTaskProposals: mocks.taskProposals,
}));
vi.mock("@/lib/tasks/access", () => ({
    taskViewerById: async () => ({ userId: "owner" }),
}));
vi.mock("@/lib/meetings/pipeline-context", () => ({
    loadRecordingAgenda: async () => null,
    agendaPlanBlock: () => "",
}));
vi.mock("@/lib/mail/redact", () => ({
    maskedContentForModel: async (content: unknown) => content,
    secretAddressMasker: async () => (text: string) => text,
}));
vi.mock("openai", () => ({
    OpenAI: class {
        chat = { completions: { create: mocks.completion } };
    },
}));
vi.mock("@/lib/summary/summary-model", async (original) => {
    const actual = await original<typeof summaryModel>();
    return {
        ...actual,
        summaryModelFor: async () => ({
            openai: { chat: { completions: { create: mocks.completion } } },
            model: "local-model",
            credentials: {
                id: "provider",
                provider: "Local provider",
                apiKey: "test",
                baseUrl: null,
                maxOutputTokens: null,
            },
            payerUserId: "owner",
            reserveCall: async () => {},
            organizationCredential: false,
        }),
    };
});

import {
    POST as addRemark,
    DELETE as deleteRemark,
    GET as getRemarks,
} from "@/app/api/recordings/[id]/summary/remarks/route";
import {
    PUT as editRoute,
    GET as getSummary,
    POST as summaryRoute,
} from "@/app/api/recordings/[id]/summary/route";
import { deleteMailSummaries } from "@/db/queries/mail-retention";
import { deleteSummaryForRecording } from "@/db/queries/retention";
import {
    decryptJsonField,
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { buildAndUploadExportArchive } from "@/lib/export/build-archive";
import type * as documentSidecars from "@/lib/export/document-sidecars";
import {
    projectSummarySpeakerReferencesForExport,
    summarySpeakerReferencesForEditor,
} from "@/lib/knowledge/speaker-references";
import { refreshSummaryAfterCorrections } from "@/lib/learn/summary-refresh";
import { planAdvance } from "@/lib/pipeline/plan";
import * as profilesModule from "@/lib/profiles/resolve";
import { buildSeedProfiles } from "@/lib/profiles/seed";
import { eraseLocalArtifact, eraseMailSummary } from "@/lib/recordings/erase";
import { queueAutoSummary } from "@/lib/summary/auto-summary";
import * as correctionsModule from "@/lib/summary/corrections";
import { summaryCorrectionsContext } from "@/lib/summary/corrections";
import { generateSummaryForRecording } from "@/lib/summary/generate-summary";
import { storedSummaryOf } from "@/lib/summary/read-summary";
import { summaryJobHandler } from "@/lib/summary/summary-job-handler";
import type * as summaryModel from "@/lib/summary/summary-model";
import {
    upsertEnhancement,
    upsertTranscription,
} from "@/lib/transcription/persist";
import { storeBrowserTranscription } from "@/lib/transcription/transcribe-recording";

function testProfile() {
    const profile = buildSeedProfiles(
        {
            autoTranscribe: false,
            autoSummarize: true,
            autoSummarizePreset: null,
            summaryMultiPass: true,
            summaryMultiPassRounds: 3,
            summaryMultiPassAuto: true,
            summaryMergePrompt: null,
            defaultTranscriptionLanguage: null,
            transcriptionQuality: "balanced",
            transcriptMode: "plaud_only",
            autoGenerateTitle: false,
            titleGenerationPrompt: null,
            summaryPrompt: null,
            autoDetectTopics: false,
            autoLearn: false,
            correctAfterLearn: true,
            mailAutoProcess: true,
            topicPrompt: null,
            aiOutputLanguage: null,
        },
        "personal",
    ).find(
        (candidate) => candidate.channel === mocks.kind && candidate.isDefault,
    );
    if (!profile) throw new Error("profile unavailable");
    return {
        ...profile,
        revisionId: "test-revision",
        settings: profile.settings,
        profile: {
            ...profile,
            id: "test-profile",
            name: "Meeting notes",
            channel: mocks.kind,
        },
    };
}

const databaseUrl = getTestDatabaseUrl();
const withDatabase = databaseUrl ? describe : describe.skip;
const ITEM = "summary-item";
const context = { params: Promise.resolve({ id: ITEM }) };
const request = (body?: unknown, query = "", suffix = "") =>
    new Request(
        `https://app.example.test/api/recordings/${ITEM}/summary${suffix}${query}`,
        {
            method: body === undefined ? "GET" : "POST",
            headers: { "Content-Type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
    );

withDatabase("#299 summary edits and remarks (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    const db = () => database.db;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            databaseUrl ?? "",
            "summary_remarks_299",
        );
        mocks.ref.current = database.db as unknown as Record<
            PropertyKey,
            unknown
        >;
    }, 120_000);
    afterAll(async () => {
        mocks.ref.current = null;
        await database?.dispose();
    }, 30_000);

    describe.each(["audio", "mail"] as const)("%s", (kind) => {
        beforeEach(async () => {
            vi.clearAllMocks();
            mocks.taskProposals.mockResolvedValue(undefined);
            mocks.actor = "owner";
            mocks.reading = "current-reading";
            mocks.org = null;
            mocks.kind = kind;
            await db().delete(users);
            await db()
                .insert(users)
                .values([
                    {
                        id: "owner",
                        email: "owner@example.test",
                        name: "Jitka Dvořáková",
                    },
                    {
                        id: "reader",
                        email: "reader@example.test",
                        name: "Tomáš Kraus",
                    },
                    { id: "org", email: "org@example.test", role: "org" },
                    { id: "curator", email: "curator@example.test" },
                ]);
            if (kind === "audio") {
                await insertRecordings(db(), {
                    id: ITEM,
                    userId: "owner",
                    filename: encryptText("Meeting"),
                    deviceSn: "local",
                    plaudFileId: "summary-file",
                    duration: 1000,
                    startTime: new Date("2026-10-01"),
                    endTime: new Date("2026-10-01T00:00:01Z"),
                    filesize: 10,
                    fileMd5: "0123456789abcdef0123456789abcdef",
                    storageType: "local",
                    storagePath: "summary.mp3",
                    plaudVersion: "1",
                });
                await db()
                    .insert(transcriptions)
                    .values([
                        {
                            id: "transcript",
                            recordingId: ITEM,
                            userId: "owner",
                            source: "riffado",
                            text: encryptText("Preferred transcript"),
                            provider: "test",
                            model: "test",
                        },
                        {
                            id: "preferred-transcript",
                            recordingId: ITEM,
                            userId: "owner",
                            source: "mixed",
                            text: encryptText("Edited transcript"),
                            provider: "test",
                            model: "test",
                        },
                    ]);
            } else {
                await db()
                    .insert(chatterItems)
                    .values({
                        id: ITEM,
                        userId: "owner",
                        kind: "mail",
                        title: encryptText("Message"),
                        occurredAt: new Date("2026-10-01"),
                    });
                await db()
                    .insert(mailMessages)
                    .values({
                        id: ITEM,
                        userId: "owner",
                        rawHash: "mail-hash",
                        receivedAt: new Date("2026-10-01"),
                        sizeBytes: 10,
                        auth: encryptJsonField({}),
                        senderVerified: true,
                    });
                await db()
                    .insert(mailContents)
                    .values({
                        itemId: ITEM,
                        userId: "owner",
                        parserVersion: 1,
                        segments: encryptJsonField([
                            {
                                index: 0,
                                role: "body",
                                depth: 0,
                                at: null,
                                text: "Preferred message",
                                participantRef: null,
                            },
                        ]),
                        language: "en",
                    });
            }
            await db()
                .insert(aiEnhancements)
                .values({
                    id: "original-summary",
                    itemId: ITEM,
                    userId: "owner",
                    transcriptionId: kind === "audio" ? "transcript" : null,
                    source: "riffado",
                    summary: encryptText("Generated summary"),
                    keyPoints: encryptJsonField(["Original point"]),
                    actionItems: encryptJsonField(["Task untouched"]),
                    inputFingerprint: "old-reading",
                    provider: "test",
                    model: "test",
                });
            await db().insert(userSettings).values({
                userId: "owner",
                summaryMultiPass: true,
                summaryMultiPassRounds: 3,
                summaryMultiPassAuto: true,
            });
            mocks.completion.mockResolvedValue({
                choices: [
                    {
                        message: {
                            content: JSON.stringify({
                                summary: "Corrected summary",
                                keyPoints: ["Corrected point"],
                                actionItems: [],
                            }),
                        },
                    },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 5 },
            });
        });

        const stored = async () =>
            (
                await db()
                    .select()
                    .from(aiEnhancements)
                    .where(
                        and(
                            eq(aiEnhancements.itemId, ITEM),
                            eq(aiEnhancements.userId, "owner"),
                            eq(aiEnhancements.source, "riffado"),
                        ),
                    )
            )[0];
        const edit = () =>
            editRoute(
                request({
                    summary: "[Jitka Dvořáková](#speaker-1) corrected it.",
                    keyPoints: ["New point"],
                    revision: 0,
                    summaryId: "original-summary",
                }),
                context,
            );
        const add = () =>
            addRemark(
                request(
                    {
                        text: "The deadline is Thursday, even if the source says Friday.",
                    },
                    "",
                    "/remarks",
                ),
                context,
            );

        it("authorizes only the owner in their own view and encrypts the saved fields", async () => {
            mocks.actor = "reader";
            expect((await edit()).status).toBe(404);
            mocks.actor = "owner";
            expect((await edit()).status).toBe(200);
            const row = await stored();
            expect(row?.summary).not.toContain("Jitka");
            expect(decryptText(row?.summary)).toBe(
                "[Speaker 1](#speaker-1) corrected it.",
            );
            expect(decryptJsonField(row?.keyPoints)).toEqual(["New point"]);
            expect(decryptJsonField(row?.actionItems)).toEqual([
                "Task untouched",
            ]);
            expect(row).toMatchObject({
                editedByUserId: "owner",
                editedAt: expect.any(Date),
                revision: 1,
            });
            expect((await edit()).status).toBe(409);
            expect(
                (
                    await editRoute(
                        request(
                            { summary: "No", keyPoints: [], revision: 1 },
                            "?source=plaud",
                        ),
                        context,
                    )
                ).status,
            ).toBe(404);
            expect(
                (
                    await addRemark(
                        request({ text: "No" }, "?source=plaud", "/remarks"),
                        context,
                    )
                ).status,
            ).toBe(404);
            expect(mocks.sidecars).toHaveBeenCalledWith(
                "owner",
                ITEM,
                "summary",
                "riffado",
            );
        });

        it("returns its own committed version when another editor writes before the save response", async () => {
            mocks.sidecars.mockImplementationOnce(async () => {
                const concurrent = await editRoute(
                    request({
                        summary: "Second editor",
                        keyPoints: [],
                        summaryId: "original-summary",
                        revision: 1,
                    }),
                    context,
                );
                expect(concurrent.status).toBe(200);
            });
            const response = await edit();
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({
                summaryId: "original-summary",
                revision: 1,
            });
            expect((await stored())?.revision).toBe(2);
            expect(decryptText((await stored())?.summary)).toBe(
                "Second editor",
            );
        });

        it("refuses correction actions in Organization and received views", async () => {
            mocks.org = "org";
            await db()
                .insert(recordingFolders)
                .values({
                    id: "shared-folder",
                    userId: "org",
                    name: encryptText("Shared"),
                    nameHash: "shared",
                    kind: "custom",
                });
            await db().insert(recordingFolderAssignments).values({
                userId: "owner",
                itemId: ITEM,
                folderId: "shared-folder",
            });
            for (const actor of ["owner", "reader", "org"]) {
                mocks.actor = actor;
                expect(
                    (
                        await editRoute(
                            request(
                                { summary: "No", keyPoints: [], revision: 0 },
                                "?view=org",
                            ),
                            context,
                        )
                    ).status,
                ).toBe(404);
                expect(
                    (
                        await getRemarks(
                            request(undefined, "?view=org", "/remarks"),
                            context,
                        )
                    ).status,
                ).toBe(404);
            }
            await db().insert(itemShares).values({
                userId: "owner",
                receiverUserId: "reader",
                itemId: ITEM,
                state: "accepted",
            });
            mocks.actor = "reader";
            expect(
                (
                    await editRoute(
                        request(
                            { summary: "No", keyPoints: [], revision: 0 },
                            "?view=received",
                        ),
                        context,
                    )
                ).status,
            ).toBe(404);
            expect(
                (
                    await getRemarks(
                        request(undefined, "?view=received", "/remarks"),
                        context,
                    )
                ).status,
            ).toBe(404);
        });

        it.each([
            "org",
            "curator",
            "owner",
        ])("never reads owner remarks for %s acting in the Organization view", async (actor) => {
            await add();
            mocks.org = "org";
            await db()
                .insert(recordingFolders)
                .values({
                    id: "org-folder",
                    userId: "org",
                    name: encryptText("Shared"),
                    nameHash: "shared",
                    kind: "custom",
                });
            await db().insert(recordingFolderAssignments).values({
                userId: "owner",
                itemId: ITEM,
                folderId: "org-folder",
            });
            mocks.actor = actor;
            const corrections = vi.spyOn(
                correctionsModule,
                "summaryCorrectionsContext",
            );
            try {
                const result = await generateSummaryForRecording(actor, ITEM, {
                    view: "org",
                    trigger: "manual",
                });
                expect(result.committed).toBe(true);
                expect(corrections).not.toHaveBeenCalled();
                expect(mocks.completion).toHaveBeenCalled();
                for (const [request] of mocks.completion.mock.calls) {
                    expect(JSON.stringify(request.messages)).not.toContain(
                        "deadline is Thursday",
                    );
                    expect(JSON.stringify(request.messages)).not.toContain(
                        "ownerCorrections",
                    );
                }
            } finally {
                corrections.mockRestore();
            }
        });

        it("loads a selected personal profile in the owner's private view even while shared", async () => {
            await edit();
            await add();
            mocks.org = "org";
            await db()
                .insert(recordingFolders)
                .values({
                    id: "org-folder",
                    userId: "org",
                    name: encryptText("Shared"),
                    nameHash: "shared",
                    kind: "custom",
                });
            await db().insert(recordingFolderAssignments).values({
                userId: "owner",
                itemId: ITEM,
                folderId: "org-folder",
            });
            const loadProfile = vi.spyOn(
                profilesModule,
                "loadSelectedProfileRevision",
            );
            try {
                expect(
                    (
                        await generateSummaryForRecording("owner", ITEM, {
                            trigger: "manual",
                            view: "private",
                            reviseWithRemarks: true,
                            expectedSummaryId: "original-summary",
                            expectedSummaryRevision: 1,
                            profileRevisionId: "test-revision",
                        })
                    ).committed,
                ).toBe(true);
                expect(loadProfile).toHaveBeenCalledWith({
                    revisionId: "test-revision",
                    actorUserId: "owner",
                    channel: kind,
                    view: "private",
                });
                expect(
                    JSON.stringify(
                        mocks.completion.mock.calls[0]?.[0].messages,
                    ),
                ).toContain("deadline is Thursday");
            } finally {
                loadProfile.mockRestore();
            }
        });

        const generatedWrite = () => ({
            userId: "owner",
            recordingId: ITEM,
            kind,
            transcriptionId: null,
            summary: "New output",
            keyPoints: [],
            actionItems: [],
            source: "riffado" as const,
            provider: "test",
            model: "test",
            pipeline: "legacy" as const,
        });

        it("commits only one of two generators that both expect an absent summary", async () => {
            await db()
                .delete(aiEnhancements)
                .where(eq(aiEnhancements.itemId, ITEM));
            const results = await Promise.all(
                [1, 2].map(() =>
                    upsertEnhancement({
                        ...generatedWrite(),
                        expectedSummaryId: null,
                    }),
                ),
            );
            expect(results.filter((result) => result.committed)).toHaveLength(
                1,
            );
            expect(
                results.filter((result) => result.reason === "outdated"),
            ).toHaveLength(1);
        });

        it("refuses a stale editor and queued generation after summary deletion and recreation", async () => {
            const original = await stored();
            if (!original) throw new Error("missing fixture");
            await db()
                .delete(aiEnhancements)
                .where(eq(aiEnhancements.id, original.id));
            await upsertEnhancement({
                ...generatedWrite(),
                expectedSummaryId: null,
            });
            const replacement = await stored();
            expect(replacement?.id).not.toBe(original.id);
            expect(replacement?.revision).toBe(original.revision);
            const response = await editRoute(
                request({
                    summary: "Old draft",
                    keyPoints: [],
                    summaryId: original.id,
                    revision: original.revision,
                }),
                context,
            );
            expect(response.status).toBe(409);
            const confirmation = await summaryRoute(
                request({
                    replaceEdited: true,
                    summaryId: original.id,
                    revision: original.revision,
                }),
                context,
            );
            expect(confirmation.status).toBe(409);
            const result = await generateSummaryForRecording("owner", ITEM, {
                trigger: "manual",
                expectedSummaryId: original.id,
                expectedSummaryRevision: original.revision,
            });
            expect(result.committed).toBe(false);
            expect(decryptText((await stored())?.summary)).toBe("New output");
        });

        it("queues the exact row identity and revision approved for replacement", async () => {
            await edit();
            const response = await summaryRoute(
                new Request(
                    `https://app.example.test/api/recordings/${ITEM}/summary`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Accept: "text/event-stream",
                        },
                        body: JSON.stringify({
                            replaceEdited: true,
                            revision: 1,
                            summaryId: "original-summary",
                        }),
                    },
                ),
                context,
            );
            expect(response.status).toBe(200);
            await response.body?.cancel();
            const [job] = await db()
                .select()
                .from(asyncJobs)
                .where(eq(asyncJobs.kind, "summary"));
            expect(job?.payload).toMatchObject({
                expectedSummaryId: "original-summary",
                expectedSummaryRevision: 1,
            });
        });

        it("keeps edited text through auto-summary and Learn refresh without paying a provider", async () => {
            await edit();
            await queueAutoSummary("owner", ITEM, null, { strict: true });
            await refreshSummaryAfterCorrections({
                ownerUserId: "owner",
                recordingId: ITEM,
                view: "private",
            });
            await generateSummaryForRecording("owner", ITEM, {
                trigger: "auto",
            });
            expect(mocks.completion).not.toHaveBeenCalled();
            expect(
                await db()
                    .select()
                    .from(asyncJobs)
                    .where(eq(asyncJobs.kind, "summary")),
            ).toHaveLength(0);
            expect((await stored())?.editedAt).toBeInstanceOf(Date);
        });

        it("requires confirmation for regeneration and rejects stale revision confirmations", async () => {
            await edit();
            expect((await summaryRoute(request({}), context)).status).toBe(409);
            expect(
                (
                    await summaryRoute(
                        request({ replaceEdited: true, revision: 0 }),
                        context,
                    )
                ).status,
            ).toBe(409);
            const row = await stored();
            await generateSummaryForRecording("owner", ITEM, {
                replaceEdited: true,
                expectedSummaryRevision: row?.revision,
                expectedSummaryId: row?.id,
            });
            expect((await stored())?.editedAt).toBeNull();
        });

        it("revises edited text in one pass, keeps attribution and records ordinary summary usage", async () => {
            await edit();
            await add();
            const before = await stored();
            await generateSummaryForRecording("owner", ITEM, {
                trigger: "manual",
                reviseWithRemarks: true,
                expectedSummaryRevision: 1,
                expectedSummaryId: "original-summary",
            });
            expect(mocks.completion).toHaveBeenCalledOnce();
            const messages = mocks.completion.mock.calls[0]?.[0].messages as {
                role: string;
                content: string;
            }[];
            const prompt =
                messages.find((message) => message.role === "user")?.content ??
                "";
            expect(prompt).toContain(
                kind === "audio" ? "Preferred transcript" : "Preferred message",
            );
            expect(prompt).toContain("[Speaker 1](#speaker-1) corrected it.");
            expect(prompt).toContain("deadline is Thursday");
            expect(
                messages.find((message) => message.role === "system")?.content,
            ).not.toContain("deadline is Thursday");
            const after = await stored();
            expect(after?.editedAt).toEqual(before?.editedAt);
            expect(after?.editedByUserId).toBe("owner");
            expect(after?.remarksAppliedCount).toBe(1);
            expect(after?.multiPassRounds).toBeNull();
            expect(
                (await db().select().from(aiUsageEvents)).map(
                    (row) => row.operation,
                ),
            ).toEqual(["summary"]);
            expect(mocks.sidecars).toHaveBeenLastCalledWith(
                "owner",
                ITEM,
                "summary",
                "riffado",
            );
        });

        it("keeps accepted tasks and dismissed proposals while storing the revision's new task proposals", async () => {
            const fingerprintOf = (text: string) => text.padEnd(64, "0");
            await db()
                .insert(recordingTasks)
                .values({
                    id: "accepted-task",
                    userId: "owner",
                    itemId: ITEM,
                    status: "open",
                    source: "riffado",
                    text: encryptText("Accepted commitment"),
                    acceptedAt: new Date(),
                    acceptedByUserId: "owner",
                });
            await db()
                .insert(recordingTaskRejections)
                .values({
                    userId: "owner",
                    itemId: ITEM,
                    fingerprintHmac: fingerprintOf("Dismissed commitment"),
                });
            await edit();
            expect(await db().select().from(recordingTasks)).toHaveLength(1);
            await add();
            mocks.taskProposals.mockResolvedValue({
                source: "riffado",
                updates: [],
                fingerprintOf,
                reviewer: {
                    userId: "owner",
                    emailHash: "unused",
                    isOrg: false,
                    isCurator: false,
                    orgUserId: null,
                },
                tasks: [
                    "Accepted commitment",
                    "Dismissed commitment",
                    "New commitment",
                ].map((text) => ({
                    text,
                    fingerprint: fingerprintOf(text),
                    assigneePersonId: null,
                    assigneeHint: null,
                    assigneeCheck: false,
                    dueDate: null,
                    duePhrase: null,
                    quote: null,
                    evidenceStartMs: null,
                })),
            });
            await generateSummaryForRecording("owner", ITEM, {
                trigger: "manual",
                reviseWithRemarks: true,
                expectedSummaryRevision: 1,
                expectedSummaryId: "original-summary",
            });
            const tasks = await db().select().from(recordingTasks);
            expect(
                tasks
                    .map((task) => [decryptText(task.text), task.status])
                    .sort(),
            ).toEqual([
                ["Accepted commitment", "open"],
                ["New commitment", "proposed"],
            ]);
            expect(
                await db().select().from(recordingTaskRejections),
            ).toHaveLength(1);
        });

        it("replays encrypted stored remarks on later automatic runs without the old summary", async () => {
            await add();
            const [remark] = await db().select().from(summaryRemarks);
            expect(remark?.text).not.toContain("Thursday");
            await generateSummaryForRecording("owner", ITEM, {
                trigger: "auto",
            });
            const requests = mocks.completion.mock.calls.map(
                ([call]) =>
                    call as { messages: { role: string; content: string }[] },
            );
            for (const call of requests) {
                expect(
                    call.messages.find((message) => message.role === "user")
                        ?.content,
                ).toContain("deadline is Thursday");
                expect(
                    call.messages.find((message) => message.role === "user")
                        ?.content,
                ).not.toContain("Generated summary");
                expect(
                    call.messages.find((message) => message.role === "system")
                        ?.content,
                ).not.toContain("deadline is Thursday");
            }
            expect((await stored())?.remarksAppliedCount).toBe(1);
        });

        it("deletes remarks without regeneration and fences a correction list changed during a run", async () => {
            await add();
            const correction = await summaryCorrectionsContext(
                "owner",
                ITEM,
                false,
            );
            const [remark] = await db().select().from(summaryRemarks);
            expect(
                (
                    await deleteRemark(
                        request(
                            undefined,
                            `?remarkId=${remark?.id}`,
                            "/remarks",
                        ),
                        context,
                    )
                ).status,
            ).toBe(200);
            expect(mocks.completion).not.toHaveBeenCalled();
            expect(
                await upsertEnhancement({
                    userId: "owner",
                    recordingId: ITEM,
                    kind,
                    transcriptionId: null,
                    summary: "Old corrections",
                    keyPoints: [],
                    actionItems: [],
                    source: "riffado",
                    provider: "test",
                    model: "test",
                    remarksFingerprint: correction.fingerprint,
                }),
            ).toMatchObject({ committed: false, reason: "outdated" });
        });

        it("does not queue the pipeline's outdated summary step for an edited summary", async () => {
            await edit();
            const current = {
                contentId: kind === "audio" ? "transcript" : "mail-content",
                contentSourceId: kind === "audio" ? "riffado" : "mail",
                contentRevision: 2,
                timed: false,
            };
            const plan = planAdvance({
                item: {
                    exists: true,
                    deleted: false,
                    kind,
                    ownerUserId: "owner",
                },
                view: "private",
                generation: 2,
                content: current,
                summaryDueAt: null,
                profile: {
                    revisionId: "profile",
                    automatic: {
                        learn: false,
                        summary: true,
                        topics: false,
                        title: false,
                    },
                },
                categorization: {
                    placementFolderIds: ["folder"],
                    intendedFolderIds: [],
                    profileAssigned: true,
                    resolution: null,
                },
                hasEnhancementCredential: true,
                mail:
                    kind === "mail"
                        ? {
                              autoGenerated: false,
                              unreadable: false,
                              shared: false,
                          }
                        : null,
                summary: {
                    exists: true,
                    stale: true,
                    edited: true,
                    jobActive: false,
                },
                taskReview: { proposals: 0, followUps: 0 },
                phases: {
                    categorize: {
                        state: "done",
                        generation: 1,
                        at: new Date().toISOString(),
                    },
                    summary: {
                        state: "done",
                        generation: 1,
                        inputs: { ...current, contentRevision: 1 },
                        at: new Date().toISOString(),
                    },
                },
                at: new Date().toISOString(),
            });
            expect(
                plan.actions.some((action) => action.type === "queueSummary"),
            ).toBe(false);
            expect(plan.actions).toContainEqual(
                expect.objectContaining({
                    type: "markPhase",
                    phase: "summary",
                    record: expect.objectContaining({
                        steps: expect.objectContaining({
                            summary: expect.objectContaining({
                                reason: "hand_edited",
                            }),
                        }),
                    }),
                }),
            );
        });

        it("fences a model result if someone hand-edits while it is running", async () => {
            await edit();
            expect(
                await upsertEnhancement({
                    userId: "owner",
                    recordingId: ITEM,
                    kind,
                    transcriptionId: null,
                    summary: "Overwritten",
                    keyPoints: [],
                    actionItems: [],
                    source: "riffado",
                    provider: "test",
                    model: "test",
                    summaryWriteMode: "regenerate",
                    expectedSummaryRevision: 0,
                    expectedSummaryId: "original-summary",
                }),
            ).toMatchObject({ committed: false, reason: "outdated" });
        });

        it("erases stored remarks together with the summary", async () => {
            await edit();
            await add();
            if (kind === "audio")
                await eraseLocalArtifact("owner", ITEM, "summary");
            else await eraseMailSummary("owner", ITEM);
            expect(await db().select().from(summaryRemarks)).toHaveLength(0);
            expect(await stored()).toBeUndefined();
        });

        it("removes remarks with summary retention and item deletion", async () => {
            await add();
            const governor = { isOrg: false, orgUserId: null };
            if (kind === "audio")
                await deleteSummaryForRecording(
                    ITEM,
                    "owner",
                    governor,
                    new Date(),
                );
            else await deleteMailSummaries(ITEM, "owner", governor, new Date());
            expect(await db().select().from(summaryRemarks)).toHaveLength(0);
            await db()
                .insert(summaryRemarks)
                .values({
                    itemId: ITEM,
                    userId: "owner",
                    authorUserId: "owner",
                    text: encryptText("A remark without a current summary"),
                });
            await db().delete(chatterItems).where(eq(chatterItems.id, ITEM));
            expect(await db().select().from(summaryRemarks)).toHaveLength(0);
        });

        it("backs up the edited marker and decrypted item remarks", async () => {
            await edit();
            await add();
            const storage = new ArchiveStorage();
            await buildAndUploadExportArchive({
                scope: { kind: "personal", userId: "owner" },
                sourceStorage: storage,
                destinationStorage: storage,
                storageKey: "archive.zip",
            });
            const archive = await unzipper.Open.buffer(storage.uploaded);
            const entries = new Map(
                await Promise.all(
                    archive.files.map(
                        async (file) =>
                            [
                                file.path,
                                (await file.buffer()).toString("utf8"),
                            ] as const,
                    ),
                ),
            );
            expect(entries.get("summaries/remarks.json")).toContain(
                "deadline is Thursday",
            );
            const summaryFile =
                [...entries].find(([path]) =>
                    kind === "audio"
                        ? path.endsWith("/summaries.json")
                        : path.endsWith("/mail.json"),
                )?.[1] ?? "";
            expect(summaryFile).toContain('"editedByUserId": "owner"');
            expect(summaryFile).toContain('"editedAt": "');
            mocks.org = "org";
            await db()
                .insert(recordingFolders)
                .values({
                    id: "org-folder",
                    userId: "org",
                    name: encryptText("Shared"),
                    nameHash: "shared",
                    kind: "custom",
                });
            await db().insert(recordingFolderAssignments).values({
                userId: "owner",
                itemId: ITEM,
                folderId: "org-folder",
            });
            await buildAndUploadExportArchive({
                scope: { kind: "organization", orgUserId: "org" },
                sourceStorage: storage,
                destinationStorage: storage,
                storageKey: "org.zip",
            });
            const orgArchive = await unzipper.Open.buffer(storage.uploaded);
            const orgText = (
                await Promise.all(
                    orgArchive.files.map(async (file) =>
                        (await file.buffer()).toString("utf8"),
                    ),
                )
            ).join("\n");
            expect(orgArchive.files.map((file) => file.path)).not.toContain(
                "summaries/remarks.json",
            );
            expect(orgText).not.toContain("deadline is Thursday");
            expect(orgText).not.toContain("remarksAppliedCount");
            expect(orgText).toContain('"editedByUserId": "owner"');
        });

        if (kind === "audio") {
            it.each([
                "summary",
                "keyPoints",
            ] as const)("retains every speaker identity after references are removed from %s", async (field) => {
                const original =
                    "[Speaker 1](#speaker-1) met [Speaker 2](#speaker-2).";
                await db()
                    .update(transcriptions)
                    .set({
                        turns: encryptJsonField([
                            {
                                speaker: "speaker_0",
                                startMs: 0,
                                endMs: 500,
                                text: "Hello",
                            },
                            {
                                speaker: "speaker_1",
                                startMs: 500,
                                endMs: 1000,
                                text: "Hello",
                            },
                        ]),
                    })
                    .where(eq(transcriptions.id, "transcript"));
                await db()
                    .update(aiEnhancements)
                    .set({
                        summary: encryptText(
                            field === "summary" ? original : "Overview",
                        ),
                        keyPoints: encryptJsonField(
                            field === "keyPoints" ? [original] : [],
                        ),
                        actionItems: encryptJsonField([]),
                    })
                    .where(eq(aiEnhancements.id, "original-summary"));
                const draft = {
                    summaryId: "original-summary",
                    revision: 0,
                    summary:
                        field === "summary"
                            ? "[Jitka Dvořáková](#speaker-1) agreed."
                            : "Overview",
                    keyPoints:
                        field === "keyPoints"
                            ? ["[Jitka Dvořáková](#speaker-1) agreed."]
                            : [],
                };
                expect((await editRoute(request(draft), context)).status).toBe(
                    200,
                );
                const row = await stored();
                if (!row) throw new Error("missing summary");
                await db()
                    .insert(people)
                    .values([
                        {
                            id: "person-a",
                            userId: "owner",
                            displayName: encryptText("Jitka Dvořáková"),
                        },
                        {
                            id: "person-b",
                            userId: "owner",
                            displayName: encryptText("Tomáš Kraus"),
                        },
                    ]);
                await db()
                    .insert(transcriptSpeakers)
                    .values([
                        {
                            userId: "owner",
                            transcriptionId: "transcript",
                            label: "speaker_0",
                            personId: "person-a",
                            source: "user",
                            status: "confirmed",
                        },
                        {
                            userId: "owner",
                            transcriptionId: "transcript",
                            label: "speaker_1",
                            personId: "person-b",
                            source: "user",
                            status: "confirmed",
                        },
                    ]);
                const { getRecordingMarkdownDocument } = await vi.importActual<
                    typeof documentSidecars
                >("@/lib/export/document-sidecars");
                const document = await getRecordingMarkdownDocument(
                    "owner",
                    ITEM,
                    "summary",
                    { source: "riffado" },
                );
                expect(document?.content).toContain("Jitka Dvořáková agreed.");
                expect(document?.content).not.toContain("Tomáš Kraus agreed.");
                const reloaded = storedSummaryOf(row);
                expect(reloaded.speakerNumberOffset).toBe(-1);
                const text =
                    field === "summary"
                        ? (reloaded.summary ?? "")
                        : reloaded.keyPoints[0];
                const attributions = {
                    speaker_0: {
                        personId: "person-a",
                        name: "Jitka Dvořáková",
                    },
                    speaker_1: { personId: "person-b", name: "Tomáš Kraus" },
                };
                expect(
                    summarySpeakerReferencesForEditor(
                        text,
                        attributions,
                        reloaded.speakerNumberOffset ?? 0,
                    ),
                ).toBe("[Jitka Dvořáková](#speaker-1) agreed.");
                expect(
                    projectSummarySpeakerReferencesForExport(
                        text,
                        (label) =>
                            attributions[label as keyof typeof attributions]
                                ?.name,
                        reloaded.speakerNumberOffset ?? 0,
                    ),
                ).toBe("Jitka Dvořáková agreed.");
                expect(
                    await (await getSummary(request(), context)).json(),
                ).toMatchObject({ speakerNumberOffset: -1 });
                expect(
                    (
                        await editRoute(
                            request({ ...draft, revision: 1 }),
                            context,
                        )
                    ).status,
                ).toBe(200);
                expect(
                    storedSummaryOf((await stored()) as typeof row)
                        .speakerNumberOffset,
                ).toBe(-1);
            });

            it.each([
                false,
                true,
            ])("uses its own first committed version for Learn catch-up, intervening edit: %s", async (interveningEdit) => {
                await db().insert(asyncJobs).values({
                    id: "summary-job",
                    userId: "owner",
                    kind: "summary",
                    subjectId: ITEM,
                    status: "processing",
                });
                mocks.completion.mockImplementation(async () => {
                    mocks.reading = "new-reading";
                    const row = await stored();
                    if (interveningEdit && row?.revision === 1) {
                        const response = await editRoute(
                            request({
                                summary: "Human draft wins",
                                keyPoints: [],
                                summaryId: row.id,
                                revision: row.revision,
                            }),
                            context,
                        );
                        expect(response.status).toBe(200);
                    }
                    return {
                        choices: [
                            {
                                message: {
                                    content: JSON.stringify({
                                        summary: "Model output",
                                        keyPoints: [],
                                        actionItems: [],
                                    }),
                                },
                            },
                        ],
                        usage: { prompt_tokens: 10, completion_tokens: 5 },
                    };
                });
                const result = await summaryJobHandler.run({
                    payload: {
                        recordingId: ITEM,
                        trigger: "manual",
                        expectedSummaryId: "original-summary",
                        expectedSummaryRevision: 0,
                    },
                    userId: "owner",
                    jobId: "summary-job",
                    attempt: 1,
                    maxAttempts: 3,
                    signal: new AbortController().signal,
                    reportProgress: async () => {},
                });
                expect(mocks.completion.mock.calls.length).toBeGreaterThan(4);
                if (interveningEdit) {
                    expect(result).toMatchObject({
                        outcome: { kind: "skipped", reason: "outdated" },
                    });
                    expect(decryptText((await stored())?.summary)).toBe(
                        "Human draft wins",
                    );
                } else {
                    expect(result).toMatchObject({ outcome: { kind: "done" } });
                    expect((await stored())?.inputFingerprint).toBe(
                        "new-reading",
                    );
                    expect((await stored())?.revision).toBe(2);
                }
            });

            it("shows the older-transcript note when a new preferred source replaces the edited summary's input", async () => {
                await db()
                    .insert(transcriptions)
                    .values({
                        id: "plaud-input",
                        recordingId: ITEM,
                        userId: "owner",
                        source: "plaud",
                        text: encryptText("Earlier input"),
                        provider: "plaud",
                        model: "plaud",
                    });
                await db()
                    .update(aiEnhancements)
                    .set({
                        transcriptionId: "plaud-input",
                        inputs: {
                            contentId: "plaud-input",
                            contentSourceId: "plaud",
                            contentRevision: 0,
                        },
                    })
                    .where(eq(aiEnhancements.itemId, ITEM));
                await edit();
                const response = await getSummary(request(), context);
                expect(response.status).toBe(200);
                expect(await response.json()).toMatchObject({
                    olderContent: true,
                    editedByName: "Jitka Dvořáková",
                });
            });

            it("keeps edited summaries and remarks through forced transcription and Plaud import", async () => {
                await edit();
                await add();
                await upsertTranscription({
                    userId: "owner",
                    recordingId: ITEM,
                    text: "Replacement transcript",
                    detectedLanguage: "en",
                    source: "riffado",
                    provider: "test",
                    model: "test",
                    dropSummaryOnReplace: "riffado",
                });
                expect((await stored())?.editedAt).toBeInstanceOf(Date);
                await upsertEnhancement({
                    userId: "owner",
                    recordingId: ITEM,
                    transcriptionId: null,
                    summary: "Plaud summary",
                    keyPoints: [],
                    actionItems: [],
                    source: "plaud",
                    provider: "plaud",
                    model: "plaud",
                });
                expect(decryptText((await stored())?.summary)).toContain(
                    "corrected it.",
                );
                await storeBrowserTranscription({
                    userId: "owner",
                    recordingId: ITEM,
                    text: "Browser replacement",
                    detectedLanguage: "en",
                    model: "browser",
                });
                expect((await stored())?.editedAt).toBeInstanceOf(Date);
                expect(await db().select().from(summaryRemarks)).toHaveLength(
                    1,
                );
                expect(mocks.removeSidecar).not.toHaveBeenCalled();
            });
        }
    });
});

class ArchiveStorage implements StorageProvider {
    uploaded = Buffer.alloc(0);
    async uploadFile(key: string): Promise<string> {
        return key;
    }
    async downloadFile(): Promise<Buffer> {
        throw new Error("not found");
    }
    async downloadStream(): Promise<Readable> {
        throw new Error("not found");
    }
    async uploadStream(key: string, stream: Readable): Promise<string> {
        const chunks: Buffer[] = [];
        for await (const chunk of stream)
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        this.uploaded = Buffer.concat(chunks);
        return key;
    }
    async exists(): Promise<boolean> {
        return false;
    }
    async getSignedUrl(): Promise<string> {
        return "";
    }
    async deleteFile(): Promise<void> {}
    async testConnection(): Promise<boolean> {
        return true;
    }
}
