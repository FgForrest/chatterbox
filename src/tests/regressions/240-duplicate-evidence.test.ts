import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { duplicateEvidence } from "@/db/queries/almanac-duplicates";
import {
    knowledgeEntities,
    knowledgeFactEvidence,
    knowledgeFacts,
    people,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { insertRecording } from "@/tests/mcp/fixtures";

const { dbRef, dbProxy } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        dbProxy: new Proxy(
            {},
            {
                get: (_target, key) => {
                    const value = ref.current?.[key];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
    };
});
vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
        DATABASE_URL: "postgres://unused",
    },
}));

const testUrl = getTestDatabaseUrl();
const withDatabase = testUrl ? describe : describe.skip;

withDatabase("duplicate evidence candidate filtering", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testUrl ?? "",
            "duplicate_evidence",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);
    beforeEach(async () => {
        await database.db.delete(users);
        await database.db.insert(users).values([
            { id: "org", email: "org@example.test", role: "org" },
            { id: "other", email: "other@example.test" },
        ]);
    });

    it.each([
        "person",
        "entity",
    ] as const)("preserves %s evidence counts with 2,000 unrelated facts", async (kind) => {
        const db = database.db;
        const ids = ["zavi", "nelo", "vemi", "ravo"];
        await db.insert(people).values(
            ids.map((id) => ({
                id,
                userId: "org",
                displayName: encryptText(id),
            })),
        );
        await db.insert(knowledgeEntities).values(
            ids.map((id) => ({
                id,
                userId: "org",
                typeKey: "project",
                name: encryptText(id),
                nameHmac: id,
            })),
        );
        const subject =
            kind === "person" ? "subjectPersonId" : "subjectEntityId";
        const object = kind === "person" ? "objectPersonId" : "objectEntityId";
        const prefix = kind === "person" ? "p" : "e";
        const facts = await db
            .insert(knowledgeFacts)
            .values(
                [
                    ["zavi", "vemi"],
                    ["vemi", "nelo"],
                    ["zavi", "nelo"],
                    ["zavi", "zavi"],
                ].map(([left, right]) => ({
                    userId: "org",
                    [subject]: left,
                    [object]: right,
                    subjectKey: `${prefix}:${left}`,
                    objectKey: `${prefix}:${right}`,
                    relationKey: "invented_relation",
                    origin: "manual" as const,
                })),
            )
            .returning({ id: knowledgeFacts.id });
        await insertRecording(db, { id: "invented-proof", userId: "org" });
        const proof = {
            userId: "org",
            itemId: "invented-proof",
            transcriptRevision: 0,
            segmentIndex: 0,
            charStart: 0,
            charEnd: 4,
            quote: encryptText("Zavi"),
        };
        await db.insert(knowledgeFactEvidence).values([
            ...facts.map(({ id }) => ({ ...proof, factId: id })),
            {
                ...proof,
                factId: facts[0].id,
                segmentIndex: 1,
                status: "wording_changed",
            },
            {
                ...proof,
                factId: facts[0].id,
                segmentIndex: 2,
                userId: "other",
            },
        ]);
        const candidates = ["zavi", "nelo", "ravo"];
        const before = new Map(
            (await duplicateEvidence("org", kind, candidates)).map(
                ({ id, count }) => [id, count],
            ),
        );
        expect(before).toEqual(
            new Map([
                ["zavi", 4],
                ["nelo", 2],
            ]),
        );
        for (let offset = 0; offset < 2000; offset += 500) {
            const unrelated = await db
                .insert(knowledgeFacts)
                .values(
                    Array.from({ length: 500 }, (_, index) => ({
                        userId: "org",
                        [subject]: "vemi",
                        subjectKey: `${prefix}:vemi`,
                        objectLiteral: encryptText(
                            `Invented value ${offset + index}`,
                        ),
                        objectKey: `l:invented-${offset + index}`,
                        relationKey: "invented_relation",
                        origin: "manual" as const,
                    })),
                )
                .returning({ id: knowledgeFacts.id });
            await db
                .insert(knowledgeFactEvidence)
                .values(unrelated.map(({ id }) => ({ ...proof, factId: id })));
        }
        expect(
            new Map(
                (await duplicateEvidence("org", kind, candidates)).map(
                    ({ id, count }) => [id, count],
                ),
            ),
        ).toEqual(before);
        expect(await duplicateEvidence("org", kind, [])).toHaveLength(0);
    });
});
