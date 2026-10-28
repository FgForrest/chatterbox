import { eq } from "drizzle-orm";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { GET } from "@/app/api/items/[id]/knowledge/route";
import {
    chatterItems,
    itemProcessing,
    itemShares,
    knowledgeAliases,
    knowledgeEntities,
    knowledgeFactEvidence,
    knowledgeFacts,
    learnReviewItems,
    learnRuns,
    mailContents,
    mailMessages,
    people,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder } from "@/lib/folders/folders";
import { itemScopeFolderIds } from "@/lib/folders/item-scope";
import { createEntity } from "@/lib/knowledge/entities";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { domainLookupHash, lookupHash } from "@/lib/knowledge/lookup-hash";
import {
    createPrivateType,
    seedCoreVocabulary,
} from "@/lib/knowledge/vocabulary";
import {
    almanacRecordsFor,
    correctionAlmanacJson,
} from "@/lib/learn/correction-pass";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import {
    almanacTermRankingInput,
    rankAlmanacTermsWithOverflow,
} from "@/lib/transcription/almanac-terms";
import { localActor } from "@/tests/helpers/session-actor";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const mocks = vi.hoisted(() => ({
    current: null as Record<PropertyKey, unknown> | null,
    viewer: "owner",
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        AUTHZ_MODE: "local",
        ORG_ACCOUNT_EMAIL: "org@example.test",
        ORG_ACCOUNT_PASSWORD: "invented-password",
        KNOWLEDGE_MEMORY_MB: 64,
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "invented-knowledge-test-secret",
        DATABASE_URL: "postgres://unused",
    },
}));
vi.mock("@/db", () => ({
    db: new Proxy(
        {},
        {
            get: (_, key) => {
                const value = mocks.current?.[key];
                return typeof value === "function"
                    ? value.bind(mocks.current)
                    : value;
            },
        },
    ),
}));
vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSessionActor: async () => ({
        session: { user: { id: mocks.viewer } },
        actor: localActor(mocks.viewer),
    }),
}));
vi.mock("@/lib/authz/curator", () => ({
    actsForOrganization: async () => mocks.viewer === "org",
    userCuratesOrganizationNow: async () => mocks.viewer === "org",
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
const url = getTestDatabaseUrl();

(url ? describe : describe.skip).each(["audio", "mail"] as const)(
    "%s item Knowledge API access",
    (kind) => {
        let database: TestPostgresDatabase;
        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                url ?? "",
                `item_knowledge_${kind}`,
            );
            mocks.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
        }, 120_000);
        afterAll(async () => {
            mocks.current = null;
            await database?.dispose();
        }, 30_000);
        beforeEach(async () => {
            mocks.viewer = "owner";
            knowledgeStore().invalidateAll();
            await database.db.delete(users);
            await database.db.insert(users).values(
                ["owner", "member", "recipient", "stranger", "org"].map(
                    (id) => ({
                        id,
                        email: `${id}@example.test`,
                        ...(id === "org" ? { role: "org" as const } : {}),
                    }),
                ),
            );
            await database.db.insert(recordingFolders).values({
                id: "org-root",
                userId: "org",
                kind: "public",
                name: encryptText("Organization"),
                nameHash: lookupHash("Organization"),
            });
            for (const id of ["item", "outside"]) {
                if (kind === "mail")
                    await database.db.insert(chatterItems).values({
                        id,
                        userId: "owner",
                        kind,
                        title: encryptText(`Invented ${id}`),
                        occurredAt: new Date("2026-10-28T10:00:00Z"),
                    });
                else
                    await insertRecordings(database.db, {
                        id,
                        userId: "owner",
                        filename: encryptText(`Invented ${id}`),
                        startTime: new Date("2026-10-28T10:00:00Z"),
                        endTime: new Date("2026-10-28T10:01:00Z"),
                        deviceSn: "test",
                        plaudFileId: id,
                        duration: 60_000,
                        filesize: 100,
                        fileMd5: "0".repeat(32),
                        storageType: "local",
                        storagePath: `test/${id}.mp3`,
                        plaudVersion: "1",
                    });
            }
            if (kind === "audio") {
                await database.db.insert(people).values([
                    {
                        id: "private-person",
                        userId: "owner",
                        displayName: encryptText("Vesna Kulra"),
                    },
                    {
                        id: "outside-person",
                        userId: "owner",
                        displayName: encryptText("Outside Person"),
                    },
                ]);
                for (const id of ["item", "outside"]) {
                    await database.db.insert(transcriptions).values({
                        id: `transcript-${id}`,
                        recordingId: id,
                        userId: "owner",
                        source: "riffado",
                        provider: "test",
                        model: "test",
                        text: encryptText("Hello"),
                        turns: encryptJsonField([
                            {
                                speaker: "speaker_0",
                                text: "Hello",
                                startMs: 0,
                                endMs: 100,
                            },
                        ]),
                    });
                    await database.db.insert(transcriptSpeakers).values({
                        userId: "owner",
                        transcriptionId: `transcript-${id}`,
                        label: "speaker_0",
                        personId:
                            id === "item" ? "private-person" : "outside-person",
                        status: "confirmed",
                        source: "calendar",
                    });
                }
            }
        });
        const request = (query = "", id = "item") =>
            GET(
                new Request(
                    `http://localhost/api/items/${id}/knowledge${query}`,
                ),
                { params: Promise.resolve({ id }) },
            );
        it("allows the owner and filters evidence to this item", async () => {
            const response = await request();
            expect(response.status).toBe(200);
            expect(response.headers.get("Cache-Control")).toBe(
                "private, no-store",
            );
            const body = await response.json();
            expect(body.item).toMatchObject({
                id: "item",
                kind,
                canReview: true,
            });
            expect(body.itemCount).toBe(1);
            expect(JSON.stringify(body)).not.toContain("Outside Person");
            if (kind === "audio")
                expect(body.records).toMatchObject([{ name: "Vesna Kulra" }]);
        });
        it("allows an Organization member without private knowledge or review drafts", async () => {
            await database.db.insert(recordingFolderAssignments).values({
                userId: "owner",
                itemId: "item",
                folderId: "org-root",
            });
            mocks.viewer = "member";
            const response = await request("?view=org");
            expect(response.status).toBe(200);
            const body = await response.json();
            expect(body.item).toMatchObject({ canReview: false, review: null });
            expect(JSON.stringify(body)).not.toContain("Vesna Kulra");
            expect((await request()).status).toBe(404);
        });
        it("allows an accepted recipient with only confirmed speaker names, then revokes access", async () => {
            await database.db.insert(itemShares).values({
                id: "share",
                itemId: "item",
                userId: "owner",
                receiverUserId: "recipient",
                state: "accepted",
            });
            mocks.viewer = "recipient";
            const response = await request(
                `?view=received&tab=${kind === "audio" ? "speakers" : "people"}`,
            );
            expect(response.status).toBe(200);
            const body = await response.json();
            expect(body.item).toMatchObject({ canReview: false, review: null });
            expect(body.records).toEqual([]);
            expect(JSON.stringify(body)).not.toContain("private-person");
            if (kind === "audio")
                expect(body.item.speakers).toEqual([
                    {
                        label: "speaker_0",
                        name: "Vesna Kulra",
                        status: "confirmed",
                        source: "calendar",
                        unknown: false,
                    },
                ]);
            await database.db
                .update(itemShares)
                .set({ state: "removed" })
                .where(eq(itemShares.id, "share"));
            expect((await request("?view=received")).status).toBe(404);
        });
        it("includes records added by earlier reviews even without other evidence", async () => {
            await database.db.insert(people).values({
                id: "new-person",
                userId: "owner",
                displayName: encryptText("New Person"),
            });
            await database.db.insert(learnRuns).values([
                {
                    id: "earlier-run",
                    itemId: "item",
                    userId: "owner",
                    scopeUserId: "owner",
                    view: "private",
                    trigger: "manual",
                    transcriptRevision: 0,
                    vocabularyVersion: 1,
                    status: "finished",
                    finishedAt: new Date("2026-10-27T10:00:00Z"),
                    createdAt: new Date("2026-10-27T10:00:00Z"),
                    inputs: { confirmedRecords: [{ personId: "new-person" }] },
                },
                {
                    id: "later-run",
                    itemId: "item",
                    userId: "owner",
                    scopeUserId: "owner",
                    view: "private",
                    trigger: "manual",
                    transcriptRevision: 0,
                    vocabularyVersion: 1,
                    status: "finished",
                    finishedAt: new Date("2026-10-28T10:00:00Z"),
                    createdAt: new Date("2026-10-28T10:00:00Z"),
                    inputs: { confirmedRecords: [] },
                },
            ]);
            const body = await (await request()).json();
            expect(
                body.records.some(
                    (record: { name: string }) => record.name === "New Person",
                ),
            ).toBe(true);
            expect(body.item.newRecordIds).toContain("new-person");
            await database.db.insert(itemShares).values({
                itemId: "item",
                userId: "owner",
                receiverUserId: "recipient",
                state: "accepted",
            });
            mocks.viewer = "recipient";
            const received = await (await request("?view=received")).json();
            expect(received.item.newRecordIds).toEqual([]);
            expect(JSON.stringify(received)).not.toContain("new-person");
            const models = await (
                await request("?view=received&tab=models")
            ).json();
            expect(models.item.modelContextAvailable).toBe(false);
            expect(models.transcription.terms).toEqual([]);
        });
        it("distinguishes a new fact from an earlier supported mention", async () => {
            if (kind === "mail")
                await database.db.insert(people).values({
                    id: "private-person",
                    userId: "owner",
                    displayName: encryptText("Vesna Kulra"),
                });
            await database.db.insert(knowledgeFacts).values({
                id: "fact",
                userId: "owner",
                subjectPersonId: "private-person",
                subjectKey: "p:private-person",
                relationKey: "has_role",
                objectLiteral: encryptText("Team lead"),
                objectKey: "l:lead",
                origin: "mail",
            });
            await database.db.insert(knowledgeFactEvidence).values([
                {
                    id: "old-evidence",
                    userId: "owner",
                    factId: "fact",
                    itemId: "outside",
                    transcriptRevision: 0,
                    segmentIndex: 0,
                    charStart: 0,
                    charEnd: 4,
                    quote: encryptText("Test"),
                    confirmedAt: new Date("2026-10-27T10:00:00Z"),
                },
                {
                    id: "new-evidence",
                    userId: "owner",
                    factId: "fact",
                    itemId: "item",
                    transcriptRevision: 0,
                    segmentIndex: 0,
                    charStart: 0,
                    charEnd: 4,
                    quote: encryptText("Test"),
                    confirmedAt: new Date("2026-10-28T10:00:00Z"),
                },
            ]);
            const mentioned = await (await request("?tab=facts")).json();
            expect(mentioned.facts).toMatchObject([
                { factId: "fact", newFromItem: false },
            ]);
            await database.db
                .delete(knowledgeFactEvidence)
                .where(eq(knowledgeFactEvidence.id, "old-evidence"));
            const fresh = await (await request("?tab=facts")).json();
            expect(fresh.facts).toMatchObject([
                { factId: "fact", newFromItem: true },
            ]);
        });
        it.each([
            ["saved", "owner"],
            ["saved", "member"],
            ["legacy", "owner"],
            ["legacy", "member"],
        ] as const)("resolves %s additions after real sharing for %s", async (format, viewer) => {
            await seedCoreVocabulary();
            const published = await createEntity("owner", {
                typeKey: "project",
                name: "Shared project",
            });
            const privateType = await createPrivateType("owner", {
                kind: "entity",
                label: "Private category",
            });
            const unpublished = await createEntity("owner", {
                typeKey: privateType,
                name: "Unpublished project",
            });
            await database.db.insert(people).values({
                id: "new-person",
                userId: "owner",
                displayName: encryptText("New Person"),
            });
            let contentId = "transcript-item";
            if (kind === "mail") {
                await database.db.insert(mailMessages).values({
                    id: "item",
                    userId: "owner",
                    rawHash: "invented-hash",
                    receivedAt: new Date(),
                    sizeBytes: 20,
                    auth: encryptJsonField({}),
                    senderVerified: true,
                });
                const [content] = await database.db
                    .insert(mailContents)
                    .values({
                        itemId: "item",
                        userId: "owner",
                        parserVersion: 1,
                        segments: encryptJsonField([]),
                    })
                    .returning();
                contentId = content.id;
            }
            await database.db.insert(learnRuns).values({
                id: "unpublished-origin",
                itemId: "item",
                userId: "owner",
                scopeUserId: "owner",
                view: "private",
                trigger: "manual",
                transcriptionId: kind === "audio" ? contentId : null,
                transcriptRevision: 0,
                vocabularyVersion: 1,
                status: "finished",
                createdAt: new Date("2026-01-01T00:00:00Z"),
                finishedAt: new Date("2026-01-01T00:01:00Z"),
                inputs: {
                    contentId,
                    contentRevision: 0,
                    confirmedRecords: [{ entityId: unpublished.id }],
                },
            });
            await database.db.insert(learnRuns).values({
                id: "private-origin",
                itemId: "item",
                userId: "owner",
                scopeUserId: "owner",
                view: "private",
                trigger: "manual",
                transcriptionId: kind === "audio" ? contentId : null,
                transcriptRevision: 0,
                vocabularyVersion: 1,
                status: "finished",
                createdAt: new Date("2026-02-01T00:00:00Z"),
                finishedAt: new Date(),
                stats: { applied: 2 },
                inputs: {
                    contentId,
                    contentRevision: 0,
                    contentSourceId: kind === "audio" ? "riffado" : "mail",
                    ...(format === "saved"
                        ? {
                              confirmedRecords: [
                                  { personId: "new-person" },
                                  { entityId: published.id },
                              ],
                          }
                        : {}),
                    privateNote: "Private review detail",
                },
            });
            await database.db.insert(learnReviewItems).values(
                format === "legacy"
                    ? [
                          {
                              runId: "private-origin",
                              userId: "owner",
                              kind: "new_record",
                              fingerprintHmac: "legacy-person",
                              outcome: "applied",
                              payload: encryptJsonField({
                                  ref: "person-ref",
                                  kind: "person",
                                  name: "New Person",
                              }),
                          },
                          {
                              runId: "private-origin",
                              userId: "owner",
                              kind: "new_record",
                              fingerprintHmac: "legacy-entity",
                              outcome: "applied",
                              payload: encryptJsonField({
                                  ref: "entity-ref",
                                  kind: "entity",
                                  typeKey: "project",
                                  name: "Shared project",
                              }),
                          },
                      ]
                    : [
                          {
                              runId: "private-origin",
                              userId: "owner",
                              kind: "new_record",
                              fingerprintHmac: "private-payload",
                              outcome: "applied",
                              payload: encryptJsonField({
                                  name: "Private review detail",
                              }),
                          },
                      ],
            );
            await addRecordingToFolder({
                userId: "owner",
                recordingId: "item",
                folderId: "org-root",
            });
            const [receipt] = await database.db
                .select()
                .from(learnRuns)
                .where(eq(learnRuns.view, "org"));
            expect(receipt.inputs).toMatchObject({
                promotedFromRunId: "private-origin",
            });
            expect(receipt.inputs?.confirmedRecords).toBeUndefined();
            expect(
                (
                    await database.db
                        .select()
                        .from(knowledgeEntities)
                        .where(eq(knowledgeEntities.id, unpublished.id))
                )[0].userId,
            ).toBe("owner");
            expect(
                (
                    await database.db
                        .select()
                        .from(people)
                        .where(eq(people.id, "new-person"))
                )[0].userId,
            ).toBe("org");
            expect(
                (
                    await database.db
                        .select()
                        .from(knowledgeEntities)
                        .where(eq(knowledgeEntities.id, published.id))
                )[0].userId,
            ).toBe("org");
            mocks.viewer = viewer;
            const personTab = await (
                await request("?view=org&tab=people")
            ).json();
            const things = await (await request("?view=org&tab=things")).json();
            expect(personTab.records).toContainEqual(
                expect.objectContaining({
                    id: "new-person",
                    name: "New Person",
                }),
            );
            expect(things.records).toEqual([
                expect.objectContaining({
                    id: published.id,
                    name: "Shared project",
                }),
            ]);
            expect(things.item.counts.things).toBe(1);
            expect(things.item.counts.people).toBe(kind === "audio" ? 2 : 1);
            expect(things.item.newRecordIds).toEqual(
                expect.arrayContaining(["new-person", published.id]),
            );
            expect(JSON.stringify(things)).not.toContain(unpublished.id);
            expect(JSON.stringify(things)).not.toContain(
                "Private review detail",
            );
            expect(things.item.learn.applied).toBe(2);
            if (viewer === "member") expect(things.item.review).toBeNull();
            await database.db
                .delete(knowledgeEntities)
                .where(eq(knowledgeEntities.id, published.id));
            const removed = await (
                await request("?view=org&tab=things")
            ).json();
            expect(removed.records).toEqual([]);
            expect(removed.item.newRecordIds).not.toContain(published.id);
        });
        if (kind === "audio") {
            it.each([
                "confirmed",
                "profile",
            ] as const)("matches real owner term and correction ranking for %s language, including a member viewer", async (languageFrom) => {
                await database.db.insert(recordingFolderAssignments).values({
                    userId: "owner",
                    itemId: "item",
                    folderId: "org-root",
                });
                await database.db
                    .update(people)
                    .set({
                        userId: "org",
                        displayName: encryptText("Zeta Speaker"),
                    })
                    .where(eq(people.id, "private-person"));
                await database.db
                    .update(people)
                    .set({ userId: "org" })
                    .where(eq(people.id, "outside-person"));
                await database.db.insert(people).values(
                    Array.from({ length: 8 }, (_, index) => ({
                        id: `rank-${index}`,
                        userId: "org",
                        displayName: encryptText(
                            index === 7 ? "Zeta Corrected" : `Alpha ${index}`,
                        ),
                    })),
                );
                await database.db.insert(transcriptCorrections).values({
                    id: "current-correction",
                    userId: "org",
                    transcriptionId: "transcript-item",
                    transcriptRevision: 0,
                    turnIndex: 0,
                    charStart: 0,
                    charEnd: 5,
                    heard: encryptText("Hello"),
                    heardHmac: domainLookupHash("correction-heard", "Hello"),
                    kind: "correct",
                    targetPersonId: "rank-7",
                    replacement: encryptText("Zeta Corrected"),
                });
                await database.db.insert(knowledgeAliases).values(
                    ["cs", "en"].map((language) => ({
                        userId: "org",
                        personId: "private-person",
                        correctionId: "current-correction",
                        kind: "heard_as" as const,
                        text: encryptText(`heard-${language}`),
                        textHmac: domainLookupHash(
                            "alias",
                            `heard-${language}`,
                        ),
                        language,
                    })),
                );
                const settings = defaultProfileSettings("audio");
                settings.steps.transcribe.language =
                    languageFrom === "profile" ? "cs" : "en";
                await database.db.insert(processingProfiles).values({
                    id: "audio-profile",
                    ownerUserId: "owner",
                    scope: "personal",
                    channel: "audio",
                    name: encryptText("Audio"),
                    currentRevisionId: "audio-revision",
                });
                await database.db.insert(processingProfileRevisions).values({
                    id: "audio-revision",
                    profileId: "audio-profile",
                    settings: encryptText(JSON.stringify(settings)),
                });
                await database.db.insert(itemProcessing).values({
                    itemId: "item",
                    userId: "owner",
                    view: "private",
                    profileId: "audio-profile",
                    profileRevisionId: "audio-revision",
                });
                if (languageFrom === "confirmed")
                    await database.db
                        .update(recordings)
                        .set({ confirmedLanguage: "cs" })
                        .where(eq(recordings.id, "item"));
                knowledgeStore().invalidateAll();
                const scopeFolderIds = await itemScopeFolderIds(
                    "item",
                    "org",
                    "owner",
                );
                const rankingInput = await almanacTermRankingInput({
                    ownerUserId: "owner",
                    shared: true,
                    language: "cs",
                    itemId: "item",
                    scopeFolderIds,
                });
                const expectedTerms =
                    rankAlmanacTermsWithOverflow(rankingInput);
                const expectedRecords = almanacRecordsFor(
                    rankingInput.items,
                    new Set(["private-person", "rank-7"]),
                    { scopeUsage: rankingInput.scopeUsage },
                );
                expect(
                    expectedRecords
                        .slice(0, 2)
                        .map((record) => record.id)
                        .sort(),
                ).toEqual(["private-person", "rank-7"]);
                const viewerRanking = await almanacTermRankingInput({
                    ownerUserId: "member",
                    shared: true,
                    language: "cs",
                    itemId: "item",
                    scopeFolderIds,
                });
                expect(viewerRanking.usage).not.toEqual(rankingInput.usage);
                for (const viewer of ["owner", "member"]) {
                    mocks.viewer = viewer;
                    const body = await (
                        await request("?view=org&tab=models")
                    ).json();
                    expect(body.language).toBe("cs");
                    expect(body.transcription.terms).toEqual(
                        expectedTerms.terms.slice(0, 8),
                    );
                    expect(
                        body.transcription.terms.find(
                            (term: { text: string }) =>
                                term.text === "Zeta Speaker",
                        ).soundsLike,
                    ).toEqual(["heard-cs"]);
                    expect(body.correction.preview).toBe(
                        `ALMANAC (JSON):\n${JSON.stringify(correctionAlmanacJson(expectedRecords.slice(0, 5)))}`,
                    );
                }
            });
        }
        if (kind === "audio")
            it("keeps a proposed Calendar speaker unconfirmed and hides it from recipients", async () => {
                await database.db.insert(transcriptSpeakers).values({
                    userId: "owner",
                    transcriptionId: "transcript-item",
                    label: "speaker_1",
                    personId: "private-person",
                    status: "suggested",
                    source: "llm",
                });
                await database.db.insert(learnRuns).values({
                    id: "ready-run",
                    itemId: "item",
                    userId: "owner",
                    scopeUserId: "owner",
                    transcriptionId: "transcript-item",
                    view: "private",
                    trigger: "manual",
                    transcriptRevision: 0,
                    vocabularyVersion: 1,
                    status: "ready",
                });
                await database.db.insert(learnReviewItems).values({
                    runId: "ready-run",
                    userId: "owner",
                    kind: "speaker",
                    fingerprintHmac: "0".repeat(64),
                    payload: encryptJsonField({
                        label: "speaker_1",
                        personId: "private-person",
                        source: "calendar",
                        evidenceMs: [],
                        reason: "Invited",
                    }),
                });
                const owner = await (await request("?tab=speakers")).json();
                expect(owner.item.speakers).toContainEqual({
                    label: "speaker_1",
                    name: "Vesna Kulra",
                    status: "suggested",
                    source: "calendar",
                    unknown: false,
                });
                expect(owner.item.learn.pending).toBe(1);
                await database.db.insert(itemShares).values({
                    itemId: "item",
                    userId: "owner",
                    receiverUserId: "recipient",
                    state: "accepted",
                });
                mocks.viewer = "recipient";
                const recipient = await (
                    await request("?view=received&tab=speakers")
                ).json();
                expect(recipient.item.speakers).not.toContainEqual(
                    expect.objectContaining({
                        label: "speaker_1",
                        status: "suggested",
                    }),
                );
                expect(recipient.item.learn.pending).toBe(0);
            });
        it("returns 404 to a stranger for every view", async () => {
            mocks.viewer = "stranger";
            for (const view of ["private", "org", "received"])
                expect((await request(`?view=${view}`)).status).toBe(404);
        });
        it("hides deleted items and validates tabs and offsets", async () => {
            expect((await request("?tab=unknown")).status).toBe(400);
            expect((await request("?offset=-1")).status).toBe(400);
            expect((await request("?offset=0.5")).status).toBe(400);
            await database.db
                .update(chatterItems)
                .set({ deletedAt: new Date() })
                .where(eq(chatterItems.id, "item"));
            expect((await request()).status).toBe(404);
        });
    },
);
