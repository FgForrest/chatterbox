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
import {
    apiCredentials,
    asyncJobs,
    folderDefaultProfiles,
    processingProfileRevisions,
    processingProfiles,
    recordingFolders,
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
            uiLocale: "en",
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
                    uiLocale: state.uiLocale,
                    email: `${state.actorId}@example.test`,
                },
                session: { id: `session-${state.actorId}` },
            },
            actor,
            authTime: new Date(),
        };
    },
}));

import { PUT as setFolderDefault } from "@/app/api/folders/[id]/default-profiles/route";
import { POST as setDefaultProfile } from "@/app/api/settings/profiles/[id]/default/route";
import { POST as duplicateProfile } from "@/app/api/settings/profiles/[id]/duplicate/route";
import { DELETE as permanentlyDeleteProfile } from "@/app/api/settings/profiles/[id]/permanent/route";
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
        state.uiLocale = "en";
        await databaseClient().delete(asyncJobs);
        await databaseClient().delete(recordingFolders);
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

    it("reports how many members selected an Organization profile before archive", async () => {
        state.actorId = "curator";
        state.capabilities = new Set(["use", "org.curate"]);
        const created = await create({
            name: "Member-selected Organization profile",
            channel: "audio",
            scope: "organization",
        });
        const id = created.body.profile.id as string;
        await databaseClient().insert(userSettings).values({
            userId: "profile-owner",
            defaultAudioProfileId: id,
        });

        const response = await getProfile(
            request("GET", `/${id}?deleteImpact=true`),
            context(id),
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            deleteImpact: { memberDefaultCount: 1 },
        });
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

    it("refuses to delete a personal default without an Organization fallback, but deletes unused non-defaults", async () => {
        state.orgEnabled = false;
        const created = await create({
            name: "Source",
            channel: "audio",
            scope: "personal",
        });
        const id = created.body.profile.id as string;
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
        const retained = await getProfile(
            request("GET", `/${id}`),
            context(id),
        );
        expect(retained.status).toBe(200);
        expect((await retained.json()).profile).toMatchObject({
            id,
            isDefault: true,
        });
        const unused = await create({
            name: "Unused",
            channel: "audio",
            scope: "personal",
        });
        const unusedId = unused.body.profile.id as string;
        const removed = await deleteProfile(
            request("DELETE", `/${unusedId}`),
            context(unusedId),
        );
        expect(removed.status).toBe(200);
        expect(await removed.json()).toMatchObject({ disposition: "delete" });
        expect(
            (
                await getProfile(
                    request("GET", `/${unusedId}`),
                    context(unusedId),
                )
            ).status,
        ).toBe(404);
    });

    it.each([
        "personal",
        "organization",
    ] as const)("lets a curator duplicate a %s profile into either scope with the current settings", async (scope) => {
        state.actorId = "curator";
        state.capabilities = new Set(["use", "org.curate"]);
        state.uiLocale = "cs-CZ";
        const created = await create({
            name: "Porady",
            channel: "audio",
            scope,
        });
        const id = created.body.profile.id as string;
        const settings = defaultProfileSettings("audio");
        settings.steps.summary.focus = "Current settings";
        await updateProfile(
            request("PUT", `/${id}`, { expectedVersion: 1, settings }),
            context(id),
        );
        for (const destination of ["personal", "organization"]) {
            const response = await duplicateProfile(
                request("POST", `/${id}/duplicate`, { scope: destination }),
                context(id),
            );
            expect(response.status).toBe(201);
            expect((await response.json()).profile).toMatchObject({
                name: "Porady (kopie)",
                scope: destination,
                isDefault: false,
                settings,
            });
        }
    });

    it("rejects duplicate into Organization for members, outsiders, and disabled scope", async () => {
        const created = await create({ name: "Source", channel: "audio" });
        const id = created.body.profile.id as string;
        expect(
            (
                await duplicateProfile(
                    request("POST", `/${id}/duplicate`, {
                        scope: "organization",
                    }),
                    context(id),
                )
            ).status,
        ).toBe(403);
        const personal = await duplicateProfile(
            request("POST", `/${id}/duplicate`),
            context(id),
        );
        expect((await personal.json()).profile).toMatchObject({
            name: "Source (copy)",
            scope: "personal",
        });
        state.actorId = "outsider";
        expect(
            (
                await duplicateProfile(
                    request("POST", `/${id}/duplicate`, {
                        scope: "organization",
                    }),
                    context(id),
                )
            ).status,
        ).toBe(404);
        state.actorId = "profile-owner";
        state.capabilities = new Set(["use", "org.curate"]);
        state.orgEnabled = false;
        expect(
            (
                await duplicateProfile(
                    request("POST", `/${id}/duplicate`, {
                        scope: "organization",
                    }),
                    context(id),
                )
            ).status,
        ).toBe(403);
    });

    it("allows the local Organization actor to copy into Organization but not personal scope", async () => {
        state.idp = false;
        state.actorId = "profile-org";
        const created = await create({
            name: "Local",
            channel: "mail",
            scope: "organization",
        });
        const id = created.body.profile.id as string;
        expect(
            (
                await setDefaultProfile(
                    request("POST", `/${id}/default`),
                    context(id),
                )
            ).status,
        ).toBe(200);
        expect(
            (
                await duplicateProfile(
                    request("POST", `/${id}/duplicate`, {
                        scope: "organization",
                    }),
                    context(id),
                )
            ).status,
        ).toBe(201);
        expect(
            (
                await duplicateProfile(
                    request("POST", `/${id}/duplicate`, { scope: "personal" }),
                    context(id),
                )
            ).status,
        ).toBe(403);
    });

    it("validates pins for the destination without changing or dropping source settings", async () => {
        state.actorId = "curator";
        state.capabilities = new Set(["use", "org.curate"]);
        await databaseClient().insert(apiCredentials).values({
            id: "curator-provider",
            userId: "curator",
            provider: "OpenAI",
            apiKey: "encrypted",
        });
        const settings = defaultProfileSettings("audio");
        settings.steps.summary.provider = {
            credentialId: "curator-provider",
            scope: "personal",
        };
        const created = await create({
            name: "Pinned",
            channel: "audio",
            settings,
        });
        const id = created.body.profile.id as string;
        const denied = await duplicateProfile(
            request("POST", `/${id}/duplicate`, { scope: "organization" }),
            context(id),
        );
        expect(denied.status).toBe(400);
        expect((await denied.json()).error).toContain(
            "Organization profiles may only pin Organization providers",
        );
        const ownCopy = await duplicateProfile(
            request("POST", `/${id}/duplicate`, { scope: "personal" }),
            context(id),
        );
        expect(ownCopy.status).toBe(201);
        expect((await ownCopy.json()).profile.settings).toEqual(settings);
    });

    it("refuses to archive the Organization default, and only permanently deletes archived profiles", async () => {
        state.actorId = "curator";
        state.capabilities = new Set(["use", "org.curate"]);
        const created = await create({
            name: "Organization default",
            channel: "audio",
            scope: "organization",
        });
        const id = created.body.profile.id as string;
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
        expect(
            (
                await permanentlyDeleteProfile(
                    request("DELETE", `/${id}/permanent`),
                    context(id),
                )
            ).status,
        ).toBe(404);
        const other = await create({
            name: "Nondefault",
            channel: "audio",
            scope: "organization",
        });
        const otherId = other.body.profile.id as string;
        expect(
            (
                await permanentlyDeleteProfile(
                    request("DELETE", `/${otherId}/permanent`),
                    context(otherId),
                )
            ).status,
        ).toBe(404);
        expect(
            (
                await deleteProfile(
                    request("DELETE", `/${otherId}`),
                    context(otherId),
                )
            ).status,
        ).toBe(200);
        expect(
            (
                await restoreProfile(
                    request("POST", `/${otherId}/restore`),
                    context(otherId),
                )
            ).status,
        ).toBe(200);
        expect(
            (
                await deleteProfile(
                    request("DELETE", `/${otherId}`),
                    context(otherId),
                )
            ).status,
        ).toBe(200);
        expect(
            (
                await permanentlyDeleteProfile(
                    request("DELETE", `/${otherId}/permanent`),
                    context(otherId),
                )
            ).status,
        ).toBe(200);
    });

    it("hides archived Organization profiles from members and tombstones from everyone, clearing all pointers", async () => {
        state.actorId = "curator";
        state.capabilities = new Set(["use", "org.curate"]);
        const created = await create({
            name: "Historical Organization",
            channel: "audio",
            scope: "organization",
        });
        const id = created.body.profile.id as string;
        const [stored] = await databaseClient()
            .select()
            .from(processingProfiles)
            .where(eq(processingProfiles.id, id));
        await databaseClient()
            .insert(asyncJobs)
            .values({
                id: "keep-revision",
                userId: "profile-owner",
                kind: "summary",
                subjectId: "item",
                status: "pending",
                payload: { profileRevisionId: stored?.currentRevisionId },
            });
        await databaseClient()
            .insert(userSettings)
            .values({
                userId: "profile-owner",
                defaultAudioProfileId: id,
                defaultMailProfileId: id,
            })
            .onConflictDoUpdate({
                target: userSettings.userId,
                set: { defaultAudioProfileId: id, defaultMailProfileId: id },
            });
        await databaseClient().insert(recordingFolders).values({
            id: "pinned-folder",
            userId: "profile-owner",
            name: "encrypted",
            nameHash: "pin",
        });
        await databaseClient().insert(folderDefaultProfiles).values({
            folderId: "pinned-folder",
            channel: "audio",
            profileId: id,
        });
        expect(
            (await deleteProfile(request("DELETE", `/${id}`), context(id)))
                .status,
        ).toBe(200);
        state.actorId = "profile-owner";
        state.capabilities = new Set(["use"]);
        expect(
            (
                await permanentlyDeleteProfile(
                    request("DELETE", `/${id}/permanent`),
                    context(id),
                )
            ).status,
        ).toBe(403);
        const memberList = await listProfiles(request("GET", "?archived=true"));
        expect(
            (await memberList.json()).profiles.map((p: { id: string }) => p.id),
        ).not.toContain(id);
        state.actorId = "curator";
        state.capabilities = new Set(["use", "org.curate"]);
        const deleted = await permanentlyDeleteProfile(
            request("DELETE", `/${id}/permanent`),
            context(id),
        );
        expect(await deleted.json()).toMatchObject({
            disposition: "tombstone",
        });
        const [profile] = await databaseClient()
            .select()
            .from(processingProfiles)
            .where(eq(processingProfiles.id, id));
        expect(profile?.deletedAt).toBeInstanceOf(Date);
        expect(
            await databaseClient()
                .select()
                .from(processingProfileRevisions)
                .where(eq(processingProfileRevisions.profileId, id)),
        ).toHaveLength(1);
        const [member] = await databaseClient()
            .select()
            .from(userSettings)
            .where(eq(userSettings.userId, "profile-owner"));
        expect(member).toMatchObject({
            defaultAudioProfileId: null,
            defaultMailProfileId: null,
        });
        expect(
            (await databaseClient().select().from(folderDefaultProfiles))[0],
        ).toMatchObject({ profileId: null, manualOnly: false });
        for (const actorId of ["curator", "profile-owner"]) {
            state.actorId = actorId;
            for (const query of [
                "?sectioned=true",
                "?archived=true",
                "?q=Historical",
                "?scope=organization",
            ]) {
                const response = await listProfiles(request("GET", query));
                expect(JSON.stringify(await response.json())).not.toContain(id);
            }
            expect(
                (await getProfile(request("GET", `/${id}`), context(id)))
                    .status,
            ).toBe(404);
            expect(
                (
                    await duplicateProfile(
                        request("POST", `/${id}/duplicate`),
                        context(id),
                    )
                ).status,
            ).toBe(404);
            expect(
                (
                    await updateProfile(
                        request("PUT", `/${id}`, {
                            expectedVersion: 1,
                            name: "Revive",
                        }),
                        context(id),
                    )
                ).status,
            ).toBe(404);
            expect(
                (
                    await restoreProfile(
                        request("POST", `/${id}/restore`),
                        context(id),
                    )
                ).status,
            ).toBe(404);
            expect(
                (
                    await setDefaultProfile(
                        request("POST", `/${id}/default`),
                        context(id),
                    )
                ).status,
            ).toBe(404);
        }
    });
    it("cannot leave a folder pinned to a concurrently deleted personal profile", async () => {
        const source = await create({
            name: "Concurrent pin",
            channel: "audio",
        });
        const id = source.body.profile.id as string;
        const [profile] = await databaseClient()
            .select()
            .from(processingProfiles)
            .where(eq(processingProfiles.id, id));
        await databaseClient()
            .insert(asyncJobs)
            .values({
                id: "pin-race-history",
                userId: "profile-owner",
                kind: "summary",
                subjectId: "item",
                payload: { profileRevisionId: profile?.currentRevisionId },
            });
        await databaseClient()
            .insert(recordingFolders)
            .values([
                {
                    id: "race-root",
                    userId: "profile-owner",
                    name: "encrypted-root",
                    nameHash: "race-root",
                },
                {
                    id: "race-child",
                    parentId: "race-root",
                    userId: "profile-owner",
                    name: "encrypted-child",
                    nameHash: "race-child",
                },
            ]);
        const [deletion, pin] = await Promise.all([
            deleteProfile(request("DELETE", `/${id}`), context(id)),
            setFolderDefault(
                new Request(
                    "https://app.example.test/api/folders/race-child/default-profiles",
                    {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            channel: "audio",
                            profileId: id,
                        }),
                    },
                ),
                context("race-child"),
            ),
        ]);
        expect(deletion.status).toBe(200);
        expect(await deletion.json()).toMatchObject({
            disposition: "tombstone",
        });
        const [retained] = await databaseClient()
            .select()
            .from(processingProfiles)
            .where(eq(processingProfiles.id, id));
        expect(retained?.deletedAt).toBeInstanceOf(Date);
        expect([200, 400, 409]).toContain(pin.status);
        const pins = await databaseClient()
            .select()
            .from(folderDefaultProfiles)
            .where(eq(folderDefaultProfiles.folderId, "race-child"));
        expect(pins.every((row) => row.profileId === null)).toBe(true);
    });
});
