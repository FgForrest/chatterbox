/**
 * The AUTHZ_MODE environment contract: `idp` needs single sign-on and an
 * adapter, nothing about it may be half-configured, `local` has no
 * provider administration, and an unknown adapter is a configuration
 * error.
 */

import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
    process.env.NEXT_PHASE = "phase-production-build";
});

import { envSchema } from "@/lib/env";

const OIDC = {
    OIDC_ISSUER_URL: "https://id.example.com/realms/acme",
    OIDC_CLIENT_ID: "chatterbox",
    OIDC_CLIENT_SECRET: "secret",
};
const IDP = { ...OIDC, AUTHZ_MODE: "idp", IDENTITY_PROVIDER: "keycloak" };
const GROUPS = {
    KEYCLOAK_GROUP_USE_ID: "00000000-0000-4000-8000-000000000001",
    KEYCLOAK_GROUP_CURATE_ID: "00000000-0000-4000-8000-000000000002",
    KEYCLOAK_GROUP_ACCESS_MANAGE_ID: "00000000-0000-4000-8000-000000000003",
};

function issuesOf(input: Record<string, string>): string[] {
    const result = envSchema.safeParse(input);
    return result.success
        ? []
        : result.error.issues.map((issue) => issue.message);
}

describe("AUTHZ_MODE", () => {
    it("defaults to local with fresh-enough verification", () => {
        const parsed = envSchema.parse({});
        expect(parsed.AUTHZ_MODE).toBe("local");
        expect(parsed.AUTHZ_VERIFICATION_MAX_AGE).toBe(1800);
        expect(parsed.AUTHZ_ADMIN_MAX_AUTH_AGE).toBe(8 * 3600);
        expect(parsed.MCP_SERVICE_CLIENTS).toEqual([]);
    });

    it("accepts a complete identity-provider configuration", () => {
        expect(
            issuesOf({
                ...IDP,
                ...GROUPS,
                KEYCLOAK_VERIFIER_CLIENT_ID: "chatterbox-verifier",
                KEYCLOAK_VERIFIER_CLIENT_SECRET: "verifier-secret",
            }),
        ).toEqual([]);
    });

    it("needs single sign-on and an adapter", () => {
        expect(issuesOf({ AUTHZ_MODE: "idp" })).toEqual(
            expect.arrayContaining([
                "AUTHZ_MODE=idp needs single sign-on (OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET)",
                "AUTHZ_MODE=idp needs IDENTITY_PROVIDER",
            ]),
        );
    });

    it("refuses an unknown adapter", () => {
        expect(
            issuesOf({ ...IDP, IDENTITY_PROVIDER: "entra" }).length,
        ).toBeGreaterThan(0);
        expect(
            issuesOf({ ...OIDC, AUTHZ_MODE: "ldap" }).length,
        ).toBeGreaterThan(0);
    });

    it("is self-host only", () => {
        expect(issuesOf({ ...IDP, IS_HOSTED: "true" })).toContain(
            "AUTHZ_MODE=idp is self-host only",
        );
    });

    it("needs a Keycloak realm issuer for the Keycloak adapter", () => {
        expect(
            issuesOf({
                ...IDP,
                OIDC_ISSUER_URL: "https://id.example.com/acme",
            }),
        ).toContain(
            "IDENTITY_PROVIDER=keycloak needs OIDC_ISSUER_URL of the form <base>/realms/<realm>",
        );
    });

    it("refuses provider settings in local mode", () => {
        expect(
            issuesOf({
                ...OIDC,
                IDENTITY_PROVIDER: "keycloak",
                ...GROUPS,
            }),
        ).toEqual(
            expect.arrayContaining([
                "IDENTITY_PROVIDER needs AUTHZ_MODE=idp",
                "KEYCLOAK_GROUP_USE_ID needs AUTHZ_MODE=idp",
            ]),
        );
    });

    it("needs all three managed groups, each its own", () => {
        expect(
            issuesOf({
                ...IDP,
                KEYCLOAK_GROUP_USE_ID: GROUPS.KEYCLOAK_GROUP_USE_ID,
            }),
        ).toContain(
            "KEYCLOAK_GROUP_USE_ID, KEYCLOAK_GROUP_CURATE_ID and KEYCLOAK_GROUP_ACCESS_MANAGE_ID must be set together",
        );
        expect(
            issuesOf({
                ...IDP,
                ...GROUPS,
                KEYCLOAK_GROUP_CURATE_ID: GROUPS.KEYCLOAK_GROUP_USE_ID,
            }),
        ).toContain("Each capability needs its own Keycloak group");
        expect(
            issuesOf({ ...IDP, ...GROUPS, KEYCLOAK_GROUP_USE_ID: "use" }),
        ).toContain("KEYCLOAK_GROUP_USE_ID must be a Keycloak group id (UUID)");
    });

    it("keeps the verifier apart from the web and MCP clients", () => {
        expect(
            issuesOf({ ...IDP, KEYCLOAK_VERIFIER_CLIENT_ID: "verifier" }),
        ).toContain(
            "KEYCLOAK_VERIFIER_CLIENT_ID and KEYCLOAK_VERIFIER_CLIENT_SECRET must be set together",
        );
        expect(
            issuesOf({
                ...IDP,
                KEYCLOAK_VERIFIER_CLIENT_ID: "chatterbox",
                KEYCLOAK_VERIFIER_CLIENT_SECRET: "s",
            }),
        ).toContain(
            "The access verifier must be its own service client, not OIDC_CLIENT_ID",
        );
        expect(
            issuesOf({
                ...IDP,
                APP_URL: "https://chatterbox.example",
                MCP_AUDIENCE: "chatterbox-mcp",
                MCP_ALLOWED_CLIENTS: "claude,verifier",
                KEYCLOAK_VERIFIER_CLIENT_ID: "verifier",
                KEYCLOAK_VERIFIER_CLIENT_SECRET: "s",
            }),
        ).toContain("The access verifier must not be an MCP client");
    });

    it("bounds the verification age at one hour", () => {
        expect(
            issuesOf({ AUTHZ_VERIFICATION_MAX_AGE: "3601" }).length,
        ).toBeGreaterThan(0);
        expect(
            envSchema.parse({ AUTHZ_VERIFICATION_MAX_AGE: "600" })
                .AUTHZ_VERIFICATION_MAX_AGE,
        ).toBe(600);
    });

    it("needs an MCP allowlist with identity-provider authorization", () => {
        expect(
            issuesOf({
                ...IDP,
                APP_URL: "https://chatterbox.example",
                MCP_AUDIENCE: "chatterbox-mcp",
            }),
        ).toContain("AUTHZ_MODE=idp with MCP needs MCP_ALLOWED_CLIENTS");
    });
});

describe("MCP_SERVICE_CLIENTS", () => {
    const MCP = {
        ...OIDC,
        APP_URL: "https://chatterbox.example",
        MCP_AUDIENCE: "chatterbox-mcp",
    };

    it("must be allowed clients", () => {
        expect(
            issuesOf({
                ...MCP,
                MCP_ALLOWED_CLIENTS: "claude",
                MCP_SERVICE_CLIENTS: "bot",
            }),
        ).toContain(
            "MCP_SERVICE_CLIENTS lists bot, which MCP_ALLOWED_CLIENTS does not",
        );
        expect(
            issuesOf({
                ...MCP,
                MCP_ALLOWED_CLIENTS: "claude,bot",
                MCP_SERVICE_CLIENTS: "bot",
            }),
        ).toEqual([]);
    });

    it("cannot name the web sign-in client", () => {
        expect(
            issuesOf({ ...MCP, MCP_SERVICE_CLIENTS: "chatterbox" }),
        ).toContain(
            "The web sign-in client (OIDC_CLIENT_ID) cannot be an MCP service client",
        );
    });

    it("needs MCP", () => {
        expect(issuesOf({ ...OIDC, MCP_SERVICE_CLIENTS: "bot" })).toContain(
            "MCP_SERVICE_CLIENTS needs MCP_AUDIENCE",
        );
    });
});
