/**
 * Settings shows Access only to an administrator of access: the server
 * decides it (`accessManagementAvailable`) and the nav builds from that.
 */

import { describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
    AUTHZ_MODE: "idp" as "idp" | "local",
    IDENTITY_PROVIDER: "keycloak",
    OIDC_ISSUER_URL: "https://id.example.com/realms/acme",
    OIDC_CLIENT_ID: "chatterbox",
    KEYCLOAK_GROUP_USE_ID: "00000000-0000-4000-8000-000000000001",
    KEYCLOAK_GROUP_CURATE_ID: "00000000-0000-4000-8000-000000000002",
    KEYCLOAK_GROUP_ACCESS_MANAGE_ID: "00000000-0000-4000-8000-000000000003" as
        | string
        | undefined,
}));

vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/db", () => ({ db: {} }));

import { buildSettingsNav } from "@/components/settings-nav-config";
import { accessManagementAvailable } from "@/lib/access/service";
import type { Capability } from "@/lib/authz/catalog";
import type { ActorContext } from "@/lib/authz/model";

function person(...capabilities: Capability[]): ActorContext {
    return {
        kind: "user",
        actorId: "u1",
        issuer: "https://id.example.com/realms/acme",
        subject: "s1",
        capabilities: new Set(capabilities),
        clientId: "chatterbox",
        clientPermissions: new Set(),
        verifiedAt: new Date(),
    };
}

function showsAccess(actor: ActorContext | null): boolean {
    return buildSettingsNav({
        isHosted: false,
        accessManagement: accessManagementAvailable(actor),
    }).some((item) => item.id === "access");
}

describe("Settings -> Access", () => {
    it("is shown to an administrator of access", () => {
        expect(showsAccess(person("use", "access.manage"))).toBe(true);
    });

    it("is hidden from everyone else", () => {
        expect(showsAccess(null)).toBe(false);
        expect(showsAccess(person("use"))).toBe(false);
        expect(showsAccess(person("use", "org.curate"))).toBe(false);
        expect(showsAccess(person("access.manage"))).toBe(false);
        expect(
            showsAccess({
                ...person("use", "access.manage"),
                kind: "service",
            }),
        ).toBe(false);
    });

    it("is hidden without the managed groups or in local mode", () => {
        mockEnv.KEYCLOAK_GROUP_ACCESS_MANAGE_ID = undefined;
        expect(showsAccess(person("use", "access.manage"))).toBe(false);
        mockEnv.KEYCLOAK_GROUP_ACCESS_MANAGE_ID =
            "00000000-0000-4000-8000-000000000003";
        mockEnv.AUTHZ_MODE = "local";
        expect(showsAccess(person("use", "access.manage"))).toBe(false);
        mockEnv.AUTHZ_MODE = "idp";
    });
});
