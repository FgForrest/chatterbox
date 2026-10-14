import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActorContext } from "@/lib/authz/model";

const mocks = vi.hoisted(() => ({
    actsForOrganization: vi.fn(),
    userCuratesOrganizationNow: vi.fn(),
    holderAccess: vi.fn(),
    isIdpAuthorization: vi.fn(),
    isOrgScopeEnabled: vi.fn(),
}));

vi.mock("@/lib/authz/curator", () => ({
    actsForOrganization: mocks.actsForOrganization,
    userCuratesOrganizationNow: mocks.userCuratesOrganizationNow,
}));
vi.mock("@/lib/authz/access-state", () => ({
    holderAccess: mocks.holderAccess,
}));
vi.mock("@/lib/identity/factory", () => ({
    isIdpAuthorization: mocks.isIdpAuthorization,
}));
vi.mock("@/lib/org/config", () => ({
    isOrgScopeEnabled: mocks.isOrgScopeEnabled,
}));

import {
    mayEditProfile,
    mayEditProfileInJob,
    mayUseProfile,
} from "@/lib/profiles/access";

const owner: ActorContext = {
    kind: "user",
    actorId: "owner",
    issuer: null,
    subject: null,
    capabilities: new Set(["use"]),
    clientId: null,
    clientPermissions: new Set(),
    verifiedAt: null,
};
const other = { ...owner, actorId: "other" };
const curator = {
    ...other,
    capabilities: new Set(["use", "org.curate"] as const),
};
const orgAccount = { ...owner, kind: "local-org" as const, actorId: "org" };
const personal = { ownerUserId: "owner", scope: "personal" as const };
const organization = { ownerUserId: "org", scope: "organization" as const };

describe("profile permissions", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isOrgScopeEnabled.mockReturnValue(true);
        mocks.isIdpAuthorization.mockReturnValue(false);
        mocks.actsForOrganization.mockImplementation(
            async (actor: ActorContext) => actor.actorId === "org",
        );
        mocks.userCuratesOrganizationNow.mockImplementation(
            async (userId: string) => userId === "org",
        );
        mocks.holderAccess.mockResolvedValue({
            ok: true,
            capabilities: new Set(["use"]),
            verifiedAt: new Date(),
        });
    });

    it("lets only the owner edit and use a personal profile", async () => {
        await expect(mayEditProfile(owner, personal)).resolves.toBe(true);
        await expect(mayEditProfile(other, personal)).resolves.toBe(false);
        await expect(mayUseProfile("owner", personal)).resolves.toBe(true);
        await expect(mayUseProfile("other", personal)).resolves.toBe(false);
    });

    it("uses local organization membership and curator rules", async () => {
        await expect(mayUseProfile("other", organization)).resolves.toBe(true);
        await expect(mayEditProfile(other, organization)).resolves.toBe(false);
        await expect(mayEditProfile(orgAccount, organization)).resolves.toBe(
            true,
        );
        await expect(mayEditProfile(curator, organization)).resolves.toBe(
            false,
        );
    });

    it("uses verified holder access and IDP curator rules", async () => {
        mocks.isIdpAuthorization.mockReturnValue(true);
        mocks.actsForOrganization.mockImplementation(
            async (actor: ActorContext) =>
                actor.kind === "user" && actor.capabilities.has("org.curate"),
        );

        await expect(mayUseProfile("other", organization)).resolves.toBe(true);
        await expect(mayEditProfile(curator, organization)).resolves.toBe(true);
        await expect(mayEditProfile(orgAccount, organization)).resolves.toBe(
            false,
        );

        mocks.holderAccess.mockResolvedValue({ ok: false, reason: "disabled" });
        await expect(mayUseProfile("other", organization)).resolves.toBe(false);
    });

    it("rechecks current curator access for jobs", async () => {
        await expect(mayEditProfileInJob("owner", personal)).resolves.toBe(
            true,
        );
        await expect(mayEditProfileInJob("other", organization)).resolves.toBe(
            false,
        );
        mocks.userCuratesOrganizationNow.mockResolvedValue(true);
        await expect(mayEditProfileInJob("other", organization)).resolves.toBe(
            true,
        );
    });

    it("denies organization use and edits while the scope is disabled", async () => {
        mocks.isOrgScopeEnabled.mockReturnValue(false);

        await expect(mayUseProfile("owner", organization)).resolves.toBe(false);
        await expect(mayEditProfile(orgAccount, organization)).resolves.toBe(
            false,
        );
        await expect(mayEditProfileInJob("org", organization)).resolves.toBe(
            false,
        );
    });
});
