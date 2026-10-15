import { and, eq } from "drizzle-orm";
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
    apiCredentials,
    processingProfiles,
    userSettings,
    users,
} from "@/db/schema";
import type { ActorContext } from "@/lib/authz/model";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { RIFFADO_INCLUDED_PROVIDER_ID } from "@/lib/transcription/included-provider";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, state } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        dbProxy: new Proxy(
            {},
            {
                get: (_target, property: string | symbol) => {
                    if (!ref.current)
                        throw new Error("test database not ready");
                    const value = ref.current[property];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
        state: {
            actorId: "profile-owner",
            idp: true,
            orgEnabled: true,
            capabilities: new Set<"use" | "org.curate">(["use"]),
            usableUsers: new Set(["profile-owner", "profile-other", "curator"]),
            mynahConfigured: false,
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        AUTHZ_MODE: "idp",
        ORG_ACCOUNT_EMAIL: "org@example.test",
        ORG_ACCOUNT_PASSWORD: "password",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        DATABASE_URL: "postgres://unused",
    },
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "profile-org",
    isOrgScopeEnabled: () => state.orgEnabled,
    isOrgScopeVisible: () => true,
}));
vi.mock("@/lib/identity/factory", () => ({
    isIdpAuthorization: () => state.idp,
}));
vi.mock("@/lib/authz/access-state", () => ({
    holderAccess: async (userId: string) =>
        state.usableUsers.has(userId)
            ? { ok: true, capabilities: new Set(["use"]) }
            : { ok: false, reason: "disabled" },
}));
vi.mock("@/lib/authz/curator", () => ({
    actsForOrganization: async (actor: ActorContext) =>
        state.idp
            ? actor.kind === "user" && actor.capabilities.has("org.curate")
            : actor.kind === "local-org" && actor.actorId === "profile-org",
    userCuratesOrganizationNow: async (userId: string) =>
        userId === "curator" || userId === "profile-org",
}));
vi.mock("@/lib/hosted/transcription/mynah", () => ({
    isMynahConfigured: () => state.mynahConfigured,
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSessionActor: async () => {
        const actor: ActorContext = {
            kind:
                !state.idp && state.actorId === "profile-org"
                    ? "local-org"
                    : "user",
            actorId: state.actorId,
            issuer: null,
            subject: null,
            capabilities: state.capabilities,
            clientId: null,
            clientPermissions: new Set(),
            verifiedAt: null,
        };
        return {
            session: {
                user: {
                    id: state.actorId,
                    email: `${state.actorId}@example.test`,
                },
                session: { id: `session-${state.actorId}` },
            },
            actor,
            authTime: new Date(),
        };
    },
}));

import { POST as setDefaultProfile } from "@/app/api/settings/profiles/[id]/default/route";
import { POST as duplicateProfile } from "@/app/api/settings/profiles/[id]/duplicate/route";
import { POST as restoreProfile } from "@/app/api/settings/profiles/[id]/restore/route";
import {
    DELETE as deleteProfile,
    GET as getProfile,
    PUT as updateProfile,
} from "@/app/api/settings/profiles/[id]/route";
import {
    POST as createProfile,
    GET as listProfiles,
} from "@/app/api/settings/profiles/route";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

function request(method: string, path = "", body?: Record<string, unknown>) {
    return new Request(
        `https://app.example.test/api/settings/profiles${path}`,
        {
            method,
            ...(body
                ? {
                      body: JSON.stringify(body),
                      headers: { "Content-Type": "application/json" },
                  }
                : {}),
        },
    );
}

function context(id: string) {
    return { params: Promise.resolve({ id }) };
}

async function create(body: Record<string, unknown>) {
    const response = await createProfile(request("POST", "", body));
    return { response, body: await response.json() };
}

describeWithDatabase("profile settings routes", () => {
    let database: TestPostgresDatabase | null = null;

    function databaseClient() {
        if (!database) throw new Error("test database not ready");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "profile_settings_routes",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await databaseClient()
            .insert(users)
            .values([
                { id: "profile-org", email: "org@example.test", role: "org" },
                { id: "profile-owner", email: "owner@example.test" },
                { id: "profile-other", email: "other@example.test" },
                { id: "curator", email: "curator@example.test" },
                { id: "outsider", email: "outsider@example.test" },
            ]);
    }, 120_000);

    beforeEach(async () => {
        state.actorId = "profile-owner";
        state.idp = true;
        state.orgEnabled = true;
        state.capabilities = new Set(["use"]);
        state.usableUsers = new Set([
            "profile-owner",
            "profile-other",
            "curator",
        ]);
        state.mynahConfigured = false;
        await databaseClient().delete(apiCredentials);
        await databaseClient().delete(processingProfiles);
        await databaseClient().delete(userSettings);
    });

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    it("shows only the actor's personal profiles plus usable Organization profiles", async () => {
        const owner = await create({
            name: "Owner only",
            channel: "audio",
            scope: "personal",
        });
        expect(owner.response.status).toBe(201);
        const detail = await getProfile(
            request("GET", `/${owner.body.profile.id}`),
            context(owner.body.profile.id),
        );
        expect(await detail.json()).toMatchObject({
            builtinPromptsVersion: expect.any(String),
            builtins: {
                focus: { en: expect.any(String), "cs-CZ": expect.any(String) },
                outputFormat: {
                    en: expect.any(String),
                    "cs-CZ": expect.any(String),
                },
            },
        });

        state.actorId = "profile-other";
        const other = await create({
            name: "Other only",
            channel: "audio",
            scope: "personal",
        });
        expect(other.response.status).toBe(201);

        state.actorId = "curator";
        state.capabilities = new Set(["use", "org.curate"]);
        const organization = await create({
            name: "Organization profile",
            channel: "audio",
            scope: "organization",
        });
        expect(organization.response.status).toBe(201);

        state.actorId = "profile-other";
        state.capabilities = new Set(["use"]);
        const response = await listProfiles(
            request("GET", "?channel=audio&q=only&page=1&pageSize=20"),
        );
        const listed = await response.json();
        expect(response.status).toBe(200);
        expect(
            listed.profiles.map((profile: { name: string }) => profile.name),
        ).toEqual(["Other only"]);
        expect(
            (
                await getProfile(
                    request("GET", `/${owner.body.profile.id}`),
                    context(owner.body.profile.id),
                )
            ).status,
        ).toBe(404);

        const orgList = await listProfiles(
            request("GET", "?scope=organization&page=1&pageSize=20"),
        );
        expect(
            (await orgList.json()).profiles.some(
                (profile: { id: string }) =>
                    profile.id === organization.body.profile.id,
            ),
        ).toBe(true);
    });

    it("enforces curator and local Organization-account editing, and hides disabled scope", async () => {
        state.actorId = "curator";
        state.capabilities = new Set(["use", "org.curate"]);
        const created = await create({
            name: "Shared",
            channel: "mail",
            scope: "organization",
        });
        const id = created.body.profile.id as string;

        state.actorId = "profile-other";
        state.capabilities = new Set(["use"]);
        expect(
            (
                await updateProfile(
                    request("PUT", `/${id}`, {
                        expectedVersion: 1,
                        name: "Member edit",
                    }),
                    context(id),
                )
            ).status,
        ).toBe(403);

        state.actorId = "curator";
        state.capabilities = new Set(["use", "org.curate"]);
        expect(
            (
                await updateProfile(
                    request("PUT", `/${id}`, {
                        expectedVersion: 1,
                        name: "Curator edit",
                    }),
                    context(id),
                )
            ).status,
        ).toBe(200);

        state.actorId = "profile-org";
        state.capabilities = new Set(["use"]);
        expect(
            (
                await updateProfile(
                    request("PUT", `/${id}`, {
                        expectedVersion: 2,
                        name: "Identity-provider Organization account edit",
                    }),
                    context(id),
                )
            ).status,
        ).toBe(404);

        state.idp = false;
        state.actorId = "profile-other";
        state.capabilities = new Set(["use", "org.curate"]);
        expect(
            (
                await updateProfile(
                    request("PUT", `/${id}`, {
                        expectedVersion: 2,
                        name: "Local member edit",
                    }),
                    context(id),
                )
            ).status,
        ).toBe(403);
        expect(
            (
                await create({
                    name: "Local personal owner",
                    channel: "audio",
                    scope: "personal",
                })
            ).response.status,
        ).toBe(201);

        state.actorId = "profile-org";
        state.capabilities = new Set(["use"]);
        expect(
            (
                await updateProfile(
                    request("PUT", `/${id}`, {
                        expectedVersion: 2,
                        name: "Organization edit",
                    }),
                    context(id),
                )
            ).status,
        ).toBe(200);

        state.orgEnabled = false;
        expect(
            (await getProfile(request("GET", `/${id}`), context(id))).status,
        ).toBe(404);
    });

    it("returns validation paths and the current version on conflict", async () => {
        const created = await create({
            name: "Validated",
            channel: "audio",
            scope: "personal",
        });
        const id = created.body.profile.id as string;
        const invalidSettings = defaultProfileSettings("audio");
        invalidSettings.steps.summary.multiPass.rounds = 99;

        const invalid = await updateProfile(
            request("PUT", `/${id}`, {
                expectedVersion: 1,
                settings: invalidSettings,
            }),
            context(id),
        );
        expect(invalid.status).toBe(400);
        expect((await invalid.json()).details.issues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: [
                        "settings",
                        "steps",
                        "summary",
                        "multiPass",
                        "rounds",
                    ],
                }),
            ]),
        );

        const changed = await updateProfile(
            request("PUT", `/${id}`, {
                expectedVersion: 1,
                name: "Changed",
            }),
            context(id),
        );
        expect(changed.status).toBe(200);
        const conflict = await updateProfile(
            request("PUT", `/${id}`, {
                expectedVersion: 1,
                name: "Stale",
            }),
            context(id),
        );
        expect(conflict.status).toBe(409);
        expect((await conflict.json()).details.currentVersion).toBe(2);
    });

    it("validates personal and Organization provider pins on create", async () => {
        await databaseClient()
            .insert(apiCredentials)
            .values([
                {
                    id: "owner-provider",
                    userId: "profile-owner",
                    provider: "OpenAI",
                    apiKey: "encrypted",
                },
                {
                    id: "other-provider",
                    userId: "profile-other",
                    provider: "OpenAI",
                    apiKey: "encrypted",
                },
                {
                    id: "org-provider",
                    userId: "profile-org",
                    provider: "OpenAI",
                    apiKey: "encrypted",
                },
            ]);

        const validPersonal = defaultProfileSettings("audio");
        validPersonal.steps.summary.provider = {
            credentialId: "owner-provider",
            scope: "personal",
        };
        expect(
            (
                await create({
                    name: "Own pin",
                    channel: "audio",
                    scope: "personal",
                    settings: validPersonal,
                })
            ).response.status,
        ).toBe(201);

        const invalidPersonal = defaultProfileSettings("audio");
        invalidPersonal.steps.summary.provider = {
            credentialId: "other-provider",
            scope: "personal",
        };
        expect(
            (
                await create({
                    name: "Other pin",
                    channel: "audio",
                    scope: "personal",
                    settings: invalidPersonal,
                })
            ).response.status,
        ).toBe(400);

        const validOrganization = defaultProfileSettings("audio");
        validOrganization.steps.summary.provider = {
            credentialId: "org-provider",
            scope: "organization",
        };
        expect(
            (
                await create({
                    name: "Organization pin in personal",
                    channel: "audio",
                    scope: "personal",
                    settings: validOrganization,
                })
            ).response.status,
        ).toBe(201);

        state.actorId = "curator";
        state.capabilities = new Set(["use", "org.curate"]);
        const organizationPin = defaultProfileSettings("audio");
        organizationPin.steps.summary.provider = {
            credentialId: "org-provider",
            scope: "organization",
        };
        expect(
            (
                await create({
                    name: "Organization provider pin",
                    channel: "audio",
                    scope: "organization",
                    settings: organizationPin,
                })
            ).response.status,
        ).toBe(201);

        const invalidOrganization = defaultProfileSettings("audio");
        invalidOrganization.steps.summary.provider = {
            credentialId: "owner-provider",
            scope: "personal",
        };
        expect(
            (
                await create({
                    name: "Personal pin in Organization",
                    channel: "audio",
                    scope: "organization",
                    settings: invalidOrganization,
                })
            ).response.status,
        ).toBe(400);
    });

    it("accepts a configured Mynah transcription pin and rejects it elsewhere", async () => {
        const transcription = defaultProfileSettings("audio");
        transcription.steps.transcribe.provider = {
            credentialId: RIFFADO_INCLUDED_PROVIDER_ID,
            scope: "personal",
        };

        state.mynahConfigured = true;
        expect(
            (
                await create({
                    name: "Mynah transcription",
                    channel: "audio",
                    scope: "personal",
                    settings: transcription,
                })
            ).response.status,
        ).toBe(201);

        state.mynahConfigured = false;
        expect(
            (
                await create({
                    name: "Unavailable Mynah",
                    channel: "audio",
                    scope: "personal",
                    settings: transcription,
                })
            ).response.status,
        ).toBe(400);

        state.mynahConfigured = true;
        const summary = defaultProfileSettings("audio");
        summary.steps.summary.provider = {
            credentialId: RIFFADO_INCLUDED_PROVIDER_ID,
            scope: "personal",
        };
        expect(
            (
                await create({
                    name: "Mynah summary",
                    channel: "audio",
                    scope: "personal",
                    settings: summary,
                })
            ).response.status,
        ).toBe(400);
    });

    it("duplicates to personal scope and protects the default from archive", async () => {
        const created = await create({
            name: "Source",
            channel: "audio",
            scope: "personal",
        });
        const id = created.body.profile.id as string;
        const duplicate = await duplicateProfile(
            request("POST", `/${id}/duplicate`),
            context(id),
        );
        expect(duplicate.status).toBe(201);
        const duplicated = (await duplicate.json()).profile;
        expect(duplicated.scope).toBe("personal");

        expect(
            (
                await deleteProfile(
                    request("DELETE", `/${duplicated.id}`),
                    context(duplicated.id),
                )
            ).status,
        ).toBe(200);
        const archived = await listProfiles(
            request("GET", "?archived=true&page=1&pageSize=20"),
        );
        expect(
            (await archived.json()).profiles.map(
                (profile: { id: string }) => profile.id,
            ),
        ).toContain(duplicated.id);
        expect(
            (
                await restoreProfile(
                    request("POST", `/${duplicated.id}/restore`),
                    context(duplicated.id),
                )
            ).status,
        ).toBe(200);
        const [restored] = await databaseClient()
            .select({
                archivedAt: processingProfiles.archivedAt,
                isDefault: processingProfiles.isDefault,
            })
            .from(processingProfiles)
            .where(eq(processingProfiles.id, duplicated.id));
        expect(restored).toEqual({ archivedAt: null, isDefault: false });

        expect(
            (
                await setDefaultProfile(
                    request("POST", `/${id}/default`),
                    context(id),
                )
            ).status,
        ).toBe(200);
        expect(
            (await deleteProfile(request("DELETE", `/${id}`), context(id)))
                .status,
        ).toBe(409);

        const defaults = await databaseClient()
            .select({ id: processingProfiles.id })
            .from(processingProfiles)
            .where(
                and(
                    eq(processingProfiles.ownerUserId, "profile-owner"),
                    eq(processingProfiles.channel, "audio"),
                    eq(processingProfiles.isDefault, true),
                ),
            );
        expect(defaults).toEqual([{ id }]);
    });
});
