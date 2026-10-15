/**
 * Curators of the Organization (AUTHZ_MODE=idp) through the real routes,
 * against a real Keycloak:
 *
 * - a curator changes a shared recording's speakers under their own
 *   identity: the new person is the Organization's, its creator the
 *   curator, never the organization account;
 * - a member, an administrator without `org.curate` and the owner are
 *   refused as before;
 * - taking `org.curate` away through access management refuses the
 *   curator's next request, and a run queued before the change (a summary,
 *   a Learn run) re-checks at execution and writes nothing.
 *
 * Opt-in: `TEST_DATABASE_URL` and `KEYCLOAK_TEST_ISSUER`.
 */

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    aiEnhancements,
    people,
    transcriptions,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import {
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { keycloakLogin } from "@/tests/authz/keycloak-login";
import {
    keycloakTestBase,
    provisionTestRealm,
    TEST_APP_URL,
    type TestRealm,
} from "@/tests/identity/keycloak-fixture";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { insertRecording, shareRecording } from "@/tests/mcp/fixtures";

const REALM = "chb-curator-it";
const REC = "rec-curated";

const { dbProxy, dbRef, mockEnv } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    const proxy = new Proxy(
        {},
        {
            get: (_target, property: string | symbol) => {
                const current = ref.current;
                if (!current)
                    throw new Error("test database was not initialized");
                const value = current[property];
                return typeof value === "function"
                    ? value.bind(current)
                    : value;
            },
        },
    );
    const issuer = process.env.KEYCLOAK_TEST_ISSUER
        ? `${new URL(process.env.KEYCLOAK_TEST_ISSUER).origin}/realms/chb-curator-it`
        : undefined;
    return {
        dbProxy: proxy,
        dbRef: ref,
        mockEnv: {
            IS_HOSTED: false,
            BILLING_ENABLED: undefined as boolean | undefined,
            SELF_HOST_MODE: "shared" as "shared" | "local",
            ORG_ACCOUNT_EMAIL: "org@example.test" as string | undefined,
            ORG_ACCOUNT_PASSWORD: undefined as string | undefined,
            ORG_ACCOUNT_NAME: undefined as string | undefined,
            OIDC_ISSUER_URL: issuer,
            OIDC_CLIENT_ID: "chatterbox",
            OIDC_CLIENT_SECRET: "chatterbox-curator-secret",
            OIDC_PROVIDER_NAME: "Keycloak",
            OIDC_SCOPES: ["openid", "profile", "email"],
            OIDC_SESSION_MAX_AGE: 24 * 60 * 60,
            DISABLE_REGISTRATION: false,
            APP_URL: "http://localhost:3000",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
            KNOWLEDGE_MEMORY_MB: 64,
            AUTHZ_MODE: "idp" as "idp" | "local",
            IDENTITY_PROVIDER: "keycloak" as const,
            KEYCLOAK_ROLES_CLIENT: undefined as string | undefined,
            KEYCLOAK_GROUP_USE_ID: undefined as string | undefined,
            KEYCLOAK_GROUP_CURATE_ID: undefined as string | undefined,
            KEYCLOAK_GROUP_ACCESS_MANAGE_ID: undefined as string | undefined,
            KEYCLOAK_VERIFIER_CLIENT_ID: "chatterbox-verifier" as
                | string
                | undefined,
            KEYCLOAK_VERIFIER_CLIENT_SECRET: "chatterbox-curator-verifier" as
                | string
                | undefined,
            AUTHZ_VERIFICATION_MAX_AGE: 1800,
            AUTHZ_ADMIN_MAX_AUTH_AGE: 8 * 3600,
            MCP_AUDIENCE: undefined as string | undefined,
            MCP_SERVICE_CLIENTS: [] as string[],
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/hosted/billing/cycle-close", () => ({
    closeCycleForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/notifications/email", () => ({
    sendEmailChangeConfirm: vi.fn(),
    sendPasswordResetEmail: vi.fn(),
    sendVerifyEmail: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
}));

import {
    GET as accessDetailRoute,
    PATCH as changeAccessRoute,
} from "@/app/api/access/subjects/[subject]/route";
import { POST as learnRoute } from "@/app/api/recordings/[id]/learn/route";
import {
    PUT as speakerChangeRoute,
    GET as speakersRoute,
} from "@/app/api/recordings/[id]/speakers/route";
import { auth } from "@/lib/auth";
import { ensureRootFolders } from "@/lib/folders/folders";
import { mayStillRun } from "@/lib/learn/learn-job-handler";
import { ensureOrgAccount } from "@/lib/org/account";
import { generateSummaryForRecording } from "@/lib/summary/generate-summary";
import {
    upsertEnhancement,
    upsertTranscription,
} from "@/lib/transcription/persist";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithKeycloak =
    testDatabaseUrl && keycloakTestBase() ? describe : describe.skip;

const TURNS = [
    { speaker: "speaker_0", startMs: 0, endMs: 4000, text: "Hello everyone." },
    { speaker: "speaker_1", startMs: 4000, endMs: 9000, text: "Thanks, hi." },
];

describeWithKeycloak("curators of the Organization (Keycloak)", () => {
    let database: TestPostgresDatabase | null = null;
    let realm: TestRealm;
    let orgUserId = "";
    const cookies: Record<string, string> = {};

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    async function userId(username: string): Promise<string> {
        const [row] = await db()
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, `${username}@example.test`))
            .limit(1);
        if (!row) throw new Error(`no local user ${username}`);
        return row.id;
    }

    function recordingRequest(
        as: string,
        path: string,
        init: RequestInit = {},
    ) {
        return new Request(`${TEST_APP_URL}${path}`, {
            ...init,
            headers: {
                cookie: cookies[as] ?? "",
                "content-type": "application/json",
                origin: TEST_APP_URL,
            },
        });
    }

    const params = { params: Promise.resolve({ id: REC }) };

    async function seen(as: string) {
        const response = await speakersRoute(
            recordingRequest(as, `/api/recordings/${REC}/speakers?view=org`),
            params,
        );
        expect(response.status).toBe(200);
        return (await response.json()) as {
            transcriptionId: string;
            revision: number;
        };
    }

    async function nameSpeaker(as: string, label: string, displayName: string) {
        const version = await seen("cora");
        return speakerChangeRoute(
            recordingRequest(as, `/api/recordings/${REC}/speakers?view=org`, {
                method: "PUT",
                body: JSON.stringify({ ...version, label, displayName }),
            }),
            params,
        );
    }

    beforeAll(async () => {
        realm = await provisionTestRealm(
            "curator",
            {
                olga: ["use"],
                cora: ["use", "org.curate"],
                mia: ["use"],
                adam: ["use", "access.manage"],
            },
            {
                realmName: REALM,
                secrets: {
                    chatterbox: "chatterbox-curator-secret",
                    "chatterbox-verifier": "chatterbox-curator-verifier",
                },
            },
        );
        mockEnv.KEYCLOAK_GROUP_USE_ID = realm.groupIds.use;
        mockEnv.KEYCLOAK_GROUP_CURATE_ID = realm.groupIds["org.curate"];
        mockEnv.KEYCLOAK_GROUP_ACCESS_MANAGE_ID =
            realm.groupIds["access.manage"];
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "curator",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        orgUserId = (await ensureOrgAccount()) ?? "";
        for (const username of Object.keys(realm.people)) {
            const person = realm.people[username];
            if (!person) continue;
            const { location, cookie } = await keycloakLogin(
                auth.handler,
                person,
            );
            expect(location).toBe("/dashboard");
            cookies[username] = cookie;
        }
        const owner = await userId("olga");
        await ensureRootFolders(owner);
        await insertRecording(db(), { id: REC, userId: owner });
        await db()
            .insert(transcriptions)
            .values({
                recordingId: REC,
                userId: owner,
                text: encryptText(
                    TURNS.map((t) => `${t.speaker}: ${t.text}`).join("\n"),
                ),
                turns: encryptJsonField(TURNS),
                provider: "elevenlabs",
                model: "scribe_v1",
                source: "riffado",
            });
        await shareRecording(db(), REC, orgUserId);
    }, 240_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
        await realm?.dispose();
    }, 60_000);

    it("lets a curator name a speaker on the Organization view, as themselves", async () => {
        const response = await nameSpeaker("cora", "speaker_0", "Nora Novak");
        expect(response.status).toBe(200);
        const curator = await userId("cora");
        const created = (
            await db().select().from(people).where(eq(people.userId, orgUserId))
        ).find((row) => decryptText(row.displayName) === "Nora Novak");
        expect(created).toMatchObject({
            userId: orgUserId,
            createdByUserId: curator,
        });
        const [speaker] = await db()
            .select()
            .from(transcriptSpeakers)
            .where(
                and(
                    eq(transcriptSpeakers.label, "speaker_0"),
                    eq(transcriptSpeakers.personId, created?.id ?? ""),
                ),
            );
        expect(speaker).toMatchObject({
            status: "confirmed",
            confirmedByUserId: curator,
        });
        expect(speaker?.confirmedByUserId).not.toBe(orgUserId);
    });

    it.each([
        ["a member", "mia"],
        ["an administrator without curation", "adam"],
        ["the owner", "olga"],
    ])("refuses %s on the Organization view", async (_label, as) => {
        const response = await nameSpeaker(as, "speaker_1", "Someone");
        expect(response.status).toBe(403);
    });

    it("refuses the owner on the private view while it is shared", async () => {
        const version = await seen("cora");
        const response = await speakerChangeRoute(
            recordingRequest("olga", `/api/recordings/${REC}/speakers`, {
                method: "PUT",
                body: JSON.stringify({
                    ...version,
                    label: "speaker_1",
                    displayName: "Someone",
                }),
            }),
            params,
        );
        expect([404, 409]).toContain(response.status);
    });

    it("authorizes a curator's Learn run and refuses a member's", async () => {
        const curator = await learnRoute(
            recordingRequest("cora", `/api/recordings/${REC}/learn?view=org`, {
                method: "POST",
            }),
            params,
        );
        expect(curator.status).toBe(400);
        expect(await curator.json()).toMatchObject({
            code: "AI_PROVIDER_NOT_CONFIGURED",
        });
        const member = await learnRoute(
            recordingRequest("mia", `/api/recordings/${REC}/learn?view=org`, {
                method: "POST",
            }),
            params,
        );
        expect(member.status).toBe(403);
    });

    it("stops a curator whose curation was taken away, also in work queued before", async () => {
        const curator = await userId("cora");
        const owner = await userId("olga");
        const run = {
            actorUserId: curator,
            itemId: REC,
            userId: owner,
            view: "org" as const,
        };
        expect(await mayStillRun(run, orgUserId)).toBe(true);
        await expect(
            generateSummaryForRecording(curator, REC, { view: "org" }),
        ).rejects.not.toMatchObject({ code: "RECORDING_SHARED" });

        const subject = realm.people.cora?.id ?? "";
        const subjectParams = { params: Promise.resolve({ subject }) };
        const detail = await accessDetailRoute(
            new Request(`${TEST_APP_URL}/api/access/subjects/${subject}`, {
                headers: { cookie: cookies.adam ?? "" },
            }),
            subjectParams,
        );
        const { access } = (await detail.json()) as {
            access: { revision: string };
        };
        const change = await changeAccessRoute(
            new Request(`${TEST_APP_URL}/api/access/subjects/${subject}`, {
                method: "PATCH",
                headers: {
                    cookie: cookies.adam ?? "",
                    origin: TEST_APP_URL,
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    remove: ["org.curate"],
                    revision: access.revision,
                }),
            }),
            subjectParams,
        );
        expect(change.status).toBe(200);

        const before = await db()
            .select()
            .from(transcriptions)
            .where(eq(transcriptions.recordingId, REC));
        const staleRun = {
            userId: owner,
            recordingId: REC,
            actorUserId: curator,
            actsForOrganization: true,
            source: "riffado" as const,
            provider: "test",
            model: "test",
        };
        expect(
            await upsertTranscription({
                ...staleRun,
                text: "Late transcript",
                detectedLanguage: "en",
            }),
        ).toEqual({ committed: false, reason: "shared" });
        expect(
            await upsertEnhancement({
                ...staleRun,
                transcriptionId: before[0]?.id ?? null,
                summary: "Late summary",
                keyPoints: [],
                actionItems: [],
            }),
        ).toEqual({ committed: false, reason: "shared" });
        expect(
            await db()
                .select()
                .from(transcriptions)
                .where(eq(transcriptions.recordingId, REC)),
        ).toEqual(before);
        expect(
            await db()
                .select()
                .from(aiEnhancements)
                .where(eq(aiEnhancements.itemId, REC)),
        ).toEqual([]);

        const refused = await nameSpeaker("cora", "speaker_1", "Late Name");
        expect(refused.status).toBe(403);
        expect(await mayStillRun(run, orgUserId)).toBe(false);
        await expect(
            generateSummaryForRecording(curator, REC, { view: "org" }),
        ).rejects.toMatchObject({ code: "RECORDING_SHARED" });
    });
});
