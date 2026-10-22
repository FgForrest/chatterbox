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
import { GET } from "@/app/api/folders/[id]/knowledge/route";
import {
    chatterItems,
    folderDefaultProfiles,
    knowledgeAliases,
    knowledgeEntities,
    knowledgeEntityTypes,
    knowledgeFactEvidence,
    knowledgeFacts,
    knowledgeRelationTypes,
    people,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { itemScopeFolderIds } from "@/lib/folders/item-scope";
import type { FolderKnowledgeResponse } from "@/lib/knowledge/folder-knowledge";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { domainLookupHash, lookupHash } from "@/lib/knowledge/lookup-hash";
import { folderModelPreview } from "@/lib/knowledge/read-folder-knowledge";
import {
    almanacRecordsFor,
    correctionAlmanacJson,
    runCorrectionPass,
} from "@/lib/learn/correction-pass";
import { folderDefaultProfile } from "@/lib/profiles/resolve-for-placement";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import {
    almanacTermRankingInput,
    almanacTermsFor,
} from "@/lib/transcription/almanac-terms";
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
        viewer: "member",
        env: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "invented-test-password",
            KNOWLEDGE_MEMORY_MB: 64,
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "folder-knowledge-test-secret",
            DATABASE_URL: "postgres://unused",
        },
        db: new Proxy(
            {},
            {
                get: (_target, key) => {
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
vi.mock("@/db", () => ({ db: mocks.db, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: mocks.viewer } }),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

const url = getTestDatabaseUrl();
const withDatabase = url ? describe : describe.skip;

withDatabase("folder knowledge API (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    const db = () => database.db;
    async function folder(
        id: string,
        userId: string,
        parentId: string | null,
        kind: "private" | "public" | "custom" = "custom",
    ) {
        await db()
            .insert(recordingFolders)
            .values({
                id,
                userId,
                parentId,
                kind,
                name: encryptText(id),
                nameHash: lookupHash(id),
            });
    }
    async function item(
        id: string,
        userId = "member",
        folderId: string | null = "private-folder",
    ) {
        await insertRecordings(db(), {
            id,
            userId,
            filename: encryptText(`Item ${id}`),
            startTime: new Date("2026-10-01T10:00:00Z"),
            deviceSn: "test",
            plaudFileId: id,
            duration: 10,
            endTime: new Date("2026-10-01T10:00:01Z"),
            filesize: 10,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${userId}/${id}.mp3`,
            plaudVersion: "1",
        });
        if (folderId)
            await db()
                .insert(recordingFolderAssignments)
                .values({ itemId: id, userId, folderId });
        await db()
            .insert(transcriptions)
            .values({
                id: `t-${id}`,
                recordingId: id,
                userId,
                text: encryptText("An invented transcript"),
                provider: "test",
                model: "test",
                source: "riffado",
            });
    }
    async function speaker(
        itemId: string,
        personId: string,
        userId = "member",
        status: "confirmed" | "suggested" | "rejected" = "confirmed",
        label = personId,
    ) {
        await db()
            .insert(transcriptSpeakers)
            .values({
                userId,
                transcriptionId: `t-${itemId}`,
                personId,
                label,
                source: "user",
                status,
            });
    }
    async function correction(itemId: string, userId = "member") {
        await db()
            .insert(transcriptCorrections)
            .values({
                userId,
                transcriptionId: `t-${itemId}`,
                transcriptRevision: 0,
                turnIndex: 0,
                charStart: 0,
                charEnd: 4,
                heard: encryptText("nulvo"),
                heardHmac: domainLookupHash("correction-heard", "nulvo"),
                kind: "correct",
                targetEntityId: "org-thing",
                replacement: encryptText("Nulvaro"),
            });
    }
    async function request(folderId: string, tab = "people", query = "") {
        return GET(
            new Request(
                `http://localhost/api/folders/${folderId}/knowledge?tab=${tab}${query}`,
            ),
            { params: Promise.resolve({ id: folderId }) },
        );
    }
    async function read(folderId: string, tab = "people", query = "") {
        const response = await request(folderId, tab, query);
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        return (await response.json()) as FolderKnowledgeResponse;
    }
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "folder_knowledge",
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
    beforeEach(async () => {
        mocks.viewer = "member";
        mocks.env.IS_HOSTED = false;
        knowledgeStore().invalidateAll();
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: "member", email: "member@example.test" },
                { id: "other", email: "other@example.test" },
                { id: "org", email: "org@example.test", role: "org" },
            ]);
        await folder("private-root", "member", null, "private");
        await folder("private-folder", "member", "private-root");
        await folder("private-child", "member", "private-folder");
        await folder("private-outside", "member", "private-root");
        await folder("org-root", "org", null, "public");
        await folder("org-folder", "org", "org-root");
        await folder("org-child", "org", "org-folder");
        await folder("other-root", "other", null, "private");
        await db()
            .insert(people)
            .values([
                {
                    id: "own-person",
                    userId: "member",
                    displayName: encryptText("Vesna Kulra"),
                    primaryEmail: encryptText("vesna@example.test"),
                    primaryEmailHash: lookupHash("vesna@example.test"),
                },
                {
                    id: "org-person",
                    userId: "org",
                    displayName: encryptText("Rulna Vekri"),
                },
                {
                    id: "other-person",
                    userId: "other",
                    displayName: encryptText("Dovra Selki"),
                },
                {
                    id: "suggested-person",
                    userId: "member",
                    displayName: encryptText("Kelna Vorli"),
                },
            ]);
        await db()
            .insert(knowledgeEntities)
            .values({
                id: "org-thing",
                userId: "org",
                typeKey: "project",
                name: encryptText("Nulvaro"),
                nameHmac: domainLookupHash("entity-name", "Nulvaro"),
            });
        await item("one");
        await item("two", "member", "private-child");
        await item("outside", "member", "private-outside");
        await item("colleague", "other", "org-child");
        await speaker("one", "own-person");
        await speaker("one", "org-person");
        await speaker("one", "other-person");
        await speaker("one", "suggested-person", "member", "suggested");
        await speaker("two", "own-person");
        await speaker("outside", "own-person");
        await speaker("colleague", "org-person", "other");
        await speaker("colleague", "other-person", "other");
        await speaker("colleague", "own-person", "other");
        await correction("one");
        await correction("two");
        await correction("colleague", "org");
        const [teacher] = await db()
            .select({ id: transcriptCorrections.id })
            .from(transcriptCorrections)
            .where(eq(transcriptCorrections.userId, "org"))
            .limit(1);
        await db()
            .insert(knowledgeAliases)
            .values([
                {
                    userId: "org",
                    entityId: "org-thing",
                    kind: "alias",
                    text: encryptText("Nuva"),
                    textHmac: domainLookupHash("alias", "Nuva"),
                },
                {
                    userId: "org",
                    entityId: "org-thing",
                    kind: "heard_as",
                    text: encryptText("nulvo"),
                    textHmac: domainLookupHash("alias", "nulvo"),
                    language: "cs",
                    correctionId: teacher?.id,
                },
            ]);
        await db().insert(knowledgeFacts).values({
            id: "fact",
            userId: "org",
            subjectPersonId: "org-person",
            subjectKey: "p:org-person",
            relationKey: "works_on",
            objectEntityId: "org-thing",
            objectKey: "e:org-thing",
            origin: "mail",
        });
        await db()
            .insert(chatterItems)
            .values({
                id: "mail",
                userId: "member",
                kind: "mail",
                title: encryptText("Invented mail"),
                occurredAt: new Date("2026-10-01T10:00:00Z"),
            });
        await db().insert(recordingFolderAssignments).values({
            userId: "member",
            itemId: "mail",
            folderId: "private-child",
        });
        await db()
            .insert(knowledgeFactEvidence)
            .values([
                {
                    id: "evidence-private",
                    userId: "org",
                    factId: "fact",
                    itemId: "mail",
                    transcriptRevision: 0,
                    segmentIndex: 0,
                    charStart: 0,
                    charEnd: 4,
                    quote: encryptText("test"),
                },
                {
                    id: "evidence-org",
                    userId: "org",
                    factId: "fact",
                    itemId: "colleague",
                    transcriptRevision: 0,
                    segmentIndex: 0,
                    charStart: 0,
                    charEnd: 4,
                    quote: encryptText("test"),
                },
            ]);
    });

    it("shows own and Organization records for private folders, deduplicating items across descendants", async () => {
        await db().insert(recordingFolderAssignments).values({
            userId: "member",
            itemId: "two",
            folderId: "private-folder",
        });
        const result = await read("private-folder");
        expect(result).toMatchObject({
            itemCount: 3,
            subfolderCount: 1,
            total: 2,
        });
        if (!("records" in result)) throw new Error("Expected records");
        expect(result.records.map((row) => row.id).sort()).toEqual([
            "org-person",
            "own-person",
        ]);
        expect(result.records).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: "own-person",
                    scope: "personal",
                    hasEmail: true,
                    itemCount: 2,
                    lastAt: expect.any(String),
                }),
                expect.objectContaining({
                    id: "org-person",
                    scope: "org",
                    hasEmail: false,
                    itemCount: 2,
                }),
            ]),
        );
        const things = await read("private-folder", "things");
        expect(things).toMatchObject({
            records: [{ name: "Nulvaro", typeKey: "project", itemCount: 3 }],
        });
    });
    it("includes unfiled items and items in other owned folders in Private root knowledge", async () => {
        await item("unfiled", "member", null);
        await speaker("unfiled", "own-person");
        await speaker("unfiled", "suggested-person");
        await correction("unfiled");
        await correction("outside");
        await item("other-private", "other", "other-root");
        await speaker("other-private", "own-person", "other");
        await speaker("other-private", "org-person", "other");
        await correction("other-private", "org");

        const peopleResult = await read("private-root", "people");
        expect(peopleResult).toMatchObject({
            itemCount: 5,
            subfolderCount: 3,
            total: 3,
        });
        if (!("records" in peopleResult)) throw new Error("Expected people");
        expect(
            peopleResult.records
                .map(({ id, itemCount }) => ({ id, itemCount }))
                .sort((left, right) => left.id.localeCompare(right.id)),
        ).toEqual([
            { id: "org-person", itemCount: 2 },
            { id: "own-person", itemCount: 4 },
            { id: "suggested-person", itemCount: 1 },
        ]);
        const thingsResult = await read("private-root", "things");
        expect(thingsResult).toMatchObject({
            itemCount: 5,
            subfolderCount: 3,
            total: 1,
            records: [{ id: "org-thing", name: "Nulvaro", itemCount: 5 }],
        });
    });
    it("shows Organization knowledge only, including colleagues' shared items", async () => {
        const result = await read("org-folder");
        expect(result).toMatchObject({
            itemCount: 1,
            records: [{ id: "org-person", scope: "org", itemCount: 1 }],
        });
        mocks.viewer = "other";
        expect(await read("org-folder")).toMatchObject({
            records: [{ id: "org-person" }],
        });
    });
    it("rejects invisible folders and hides Organization folders in hosted mode", async () => {
        expect((await request("other-root")).status).toBe(404);
        expect((await request("missing")).status).toBe(404);
        mocks.viewer = "other";
        expect((await request("private-folder")).status).toBe(404);
        mocks.env.IS_HOSTED = true;
        expect((await request("org-folder")).status).toBe(404);
        mocks.viewer = "member";
        expect(await read("private-folder")).toMatchObject({
            records: [{ id: "own-person", scope: "personal" }],
        });
        expect(await read("private-folder", "things")).toMatchObject({
            records: [],
        });
    });
    it("counts correction uses and returns only supported evidence from the folder subtree", async () => {
        expect(await read("private-folder", "corrections")).toMatchObject({
            total: 1,
            corrections: [
                {
                    heard: "nulvo",
                    targetName: "Nulvaro",
                    useCount: 2,
                    itemCount: 2,
                },
            ],
        });
        expect(await read("org-folder", "corrections")).toMatchObject({
            corrections: [{ useCount: 1, scope: "org" }],
        });
        expect(await read("private-folder", "facts")).toMatchObject({
            total: 1,
            facts: [
                {
                    subject: "Rulna Vekri",
                    object: "Nulvaro",
                    itemId: "mail",
                    itemTitle: "Invented mail",
                    itemDate: "2026-10-01T10:00:00.000Z",
                },
            ],
        });
        await db()
            .update(knowledgeFactEvidence)
            .set({ status: "wording_changed" })
            .where(eq(knowledgeFactEvidence.id, "evidence-private"));
        expect(await read("private-folder", "facts")).toMatchObject({
            total: 0,
            facts: [],
        });
        await db()
            .update(chatterItems)
            .set({ deletedAt: new Date() })
            .where(eq(chatterItems.id, "two"));
        expect(await read("private-folder", "corrections")).toMatchObject({
            corrections: [{ useCount: 1 }],
        });
    });
    it.each([
        "private-folder",
        "org-folder",
        "private-root",
    ])("matches transcription and correction pipeline contexts in %s", async (folderId) => {
        const shared = folderId.startsWith("org");
        const result = await read(folderId, "models");
        if (result.tab !== "models") throw new Error("Expected model preview");
        await item("new-item", "member", folderId);
        const scopeFolderIds = await itemScopeFolderIds(
            "new-item",
            shared ? "org" : "private",
            "member",
        );
        const input = {
            ownerUserId: "member",
            shared,
            language: null,
            itemId: "new-item",
            scopeFolderIds,
        };
        expect(
            result.transcription.terms.map(({ text, soundsLike }) => ({
                text,
                soundsLike,
            })),
        ).toEqual(await almanacTermsFor(input));
        const ranking = await almanacTermRankingInput(input);
        const records = almanacRecordsFor(ranking.items, new Set(), {
            scopeUsage: ranking.scopeUsage,
        });
        expect(
            result.transcription.terms.find((term) => term.text === "Nulvaro"),
        ).toMatchObject({ soundsLike: ["nulvo"], reason: { mishearings: 1 } });
        expect(
            result.transcription.terms.some((term) => term.text === "Nuva"),
        ).toBe(true);
        expect(result.correction.count).toBe(records.length);
        expect(result.correction.preview).toBe(
            `ALMANAC (JSON):\n${JSON.stringify(correctionAlmanacJson(records.slice(0, 5)))}`,
        );
        let prompt = "";
        await runCorrectionPass({
            path: "fallback",
            bridge: { complete: vi.fn() },
            chat: {
                complete: async (messages) => {
                    prompt =
                        messages.find((message) => message.role === "user")
                            ?.content ?? "";
                    return '{"fixes":[]}';
                },
            },
            token: "test",
            turns: [
                {
                    text: "An invented turn",
                    startMs: 0,
                    endMs: 10,
                    speaker: "speaker_0",
                },
            ],
            language: null,
            almanac: records.slice(0, 5),
            corrected: [],
        });
        expect(prompt).toContain(result.correction.preview);
        expect(result.folder.isRoot).toBe(folderId === "private-root");
    });
    it("bounds pages and model context around the 500-term cut line", async () => {
        await db()
            .insert(people)
            .values(
                Array.from({ length: 510 }, (_, index) => ({
                    id: `extra-${index}`,
                    userId: "org",
                    displayName: encryptText(`Velnaro ${index}`),
                })),
            );
        await db()
            .insert(transcriptSpeakers)
            .values(
                Array.from({ length: 55 }, (_, index) => ({
                    userId: "other",
                    transcriptionId: "t-colleague",
                    label: `extra-${index}`,
                    personId: `extra-${index}`,
                    source: "user" as const,
                    status: "confirmed" as const,
                })),
            );
        knowledgeStore().invalidateAll();
        const first = await read("org-folder");
        const second = await read("org-folder", "people", "&offset=50");
        expect(first).toMatchObject({ total: 56, nextOffset: 50 });
        if (!("records" in first) || !("records" in second))
            throw new Error("Expected records");
        expect(first.records).toHaveLength(50);
        expect(second.records).toHaveLength(6);
        expect(
            new Set([...first.records, ...second.records].map((row) => row.id))
                .size,
        ).toBe(56);
        const models = await read("org-folder", "models");
        if (models.tab !== "models") throw new Error("Expected models");
        expect(models.transcription.terms).toHaveLength(8);
        expect(models.transcription.sent).toBe(500);
        await item("new-item", "member", "org-folder");
        const scopeFolderIds = await itemScopeFolderIds(
            "new-item",
            "org",
            "member",
        );
        const full = await folderModelPreview({
            viewerId: "member",
            folderId: "org-folder",
            shared: true,
            scopeFolderIds,
        });
        expect(
            full.transcription.terms.map(({ text, soundsLike }) => ({
                text,
                soundsLike,
            })),
        ).toEqual(
            await almanacTermsFor({
                ownerUserId: "member",
                shared: true,
                language: null,
                itemId: "new-item",
                scopeFolderIds,
            }),
        );
        expect(models.transcription.terms).toEqual(
            full.transcription.terms.slice(0, 8),
        );
        expect(models.transcription.belowCut).toHaveLength(3);
        expect(models.transcription.total).toBe(513);
        expect(models.correction).toMatchObject({
            count: 500,
            previewCount: 5,
        });
    });
    it.each([
        "private-child",
        "org-child",
    ])("uses an inherited pinned audio language for preview parity in %s", async (folderId) => {
        const shared = folderId.startsWith("org");
        const ownerId = shared ? "org" : "member";
        const settings = defaultProfileSettings("audio");
        settings.steps.transcribe.language = "cs";
        await db()
            .insert(processingProfiles)
            .values({
                id: "audio-profile",
                ownerUserId: ownerId,
                scope: shared ? "organization" : "personal",
                channel: "audio",
                name: encryptText("Velnaro audio"),
                currentRevisionId: "audio-revision",
                createdBy: ownerId,
                updatedBy: ownerId,
            });
        await db()
            .insert(processingProfileRevisions)
            .values({
                id: "audio-revision",
                profileId: "audio-profile",
                settings: encryptText(JSON.stringify(settings)),
                createdBy: ownerId,
            });
        await db()
            .insert(folderDefaultProfiles)
            .values({
                folderId: shared ? "org-folder" : "private-folder",
                channel: "audio",
                profileId: "audio-profile",
            });
        const [teacher] = await db()
            .select({ id: transcriptCorrections.id })
            .from(transcriptCorrections)
            .where(eq(transcriptCorrections.userId, "org"))
            .limit(1);
        if (!teacher) throw new Error("Expected correction");
        await db()
            .insert(knowledgeAliases)
            .values({
                userId: "org",
                entityId: "org-thing",
                kind: "heard_as",
                correctionId: teacher.id,
                text: encryptText("noolvah"),
                textHmac: domainLookupHash("alias", "noolvah"),
                language: "en",
            });
        knowledgeStore().invalidateAll();
        const result = await read(folderId, "models");
        if (result.tab !== "models") throw new Error("Expected models");
        const profile = await folderDefaultProfile(folderId, "audio");
        const language =
            profile && "transcribe" in profile.settings.steps
                ? profile.settings.steps.transcribe.language
                : null;
        expect(language).toBe("cs");
        expect(result.language).toBe(language);
        await item("new-item", "member", folderId);
        const scopeFolderIds = await itemScopeFolderIds(
            "new-item",
            shared ? "org" : "private",
            "member",
        );
        const full = await folderModelPreview({
            viewerId: "member",
            folderId,
            shared,
            scopeFolderIds,
        });
        const pipeline = {
            ownerUserId: "member",
            shared,
            language,
            itemId: "new-item",
            scopeFolderIds,
        };
        expect(
            full.transcription.terms.map(({ text, soundsLike }) => ({
                text,
                soundsLike,
            })),
        ).toEqual(await almanacTermsFor(pipeline));
        expect(result.transcription.terms).toEqual(
            full.transcription.terms.slice(0, 8),
        );
        expect(
            result.transcription.terms.find((term) => term.text === "Nulvaro")
                ?.soundsLike,
        ).toEqual(["nulvo"]);
        expect(
            await almanacTermsFor({ ...pipeline, language: null }),
        ).not.toEqual(await almanacTermsFor(pipeline));
        expect(await read(folderId, "models", "&language=en")).toMatchObject({
            language: "en",
        });
    });
    it.each([
        "people",
        "things",
        "corrections",
        "facts",
    ])("reads the subtree once for %s, even on an empty page", async (tab) => {
        await db().insert(recordingFolderAssignments).values({
            userId: "other",
            itemId: "colleague",
            folderId: "org-folder",
        });
        const execute = vi.spyOn(database.db, "execute");
        try {
            expect(await read("org-folder", tab)).toMatchObject({
                itemCount: 1,
                subfolderCount: 1,
            });
            expect(execute).toHaveBeenCalledTimes(1);
            execute.mockClear();
            expect(await read("org-folder", tab, "&offset=1000")).toMatchObject(
                { itemCount: 1, subfolderCount: 1 },
            );
            expect(execute).toHaveBeenCalledTimes(1);
        } finally {
            execute.mockRestore();
        }
    });
    it("returns readable custom vocabulary labels for entities and facts", async () => {
        await db()
            .insert(knowledgeEntityTypes)
            .values({
                key: "org:velnaro-kind",
                userId: "org",
                label: encryptText("Velnaro kind"),
                labelHmac: domainLookupHash(
                    "entity-type-label",
                    "Velnaro kind",
                ),
                status: "active",
            });
        await db()
            .insert(knowledgeRelationTypes)
            .values({
                key: "org:velnaro-relation",
                userId: "org",
                label: encryptText("Velnaro relation"),
                labelHmac: domainLookupHash(
                    "relation-type-label",
                    "Velnaro relation",
                ),
                cardinality: "many",
                status: "active",
                subjectTypes: ["person"],
                objectTypes: ["org:velnaro-kind"],
                objectKind: "entity",
            });
        await db()
            .update(knowledgeEntities)
            .set({ typeKey: "org:velnaro-kind" })
            .where(eq(knowledgeEntities.id, "org-thing"));
        await db()
            .update(knowledgeFacts)
            .set({ relationKey: "org:velnaro-relation" })
            .where(eq(knowledgeFacts.id, "fact"));
        expect(await read("org-folder", "things")).toMatchObject({
            records: [
                { typeKey: "org:velnaro-kind", typeLabel: "Velnaro kind" },
            ],
        });
        expect(await read("org-folder", "facts")).toMatchObject({
            facts: [
                {
                    relationKey: "org:velnaro-relation",
                    relationLabel: "Velnaro relation",
                },
            ],
        });
    });
    it("validates tab, pagination and language", async () => {
        expect((await request("private-folder", "invalid")).status).toBe(400);
        expect(
            (await request("private-folder", "people", "&offset=-1")).status,
        ).toBe(400);
        expect(
            (await request("private-folder", "people", "&offset=0.5")).status,
        ).toBe(400);
        expect(
            (
                await request(
                    "private-folder",
                    "models",
                    "&language=bad%20language",
                )
            ).status,
        ).toBe(400);
    });
});
