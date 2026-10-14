/**
 * The Keycloak claims contract: capabilities from the configured client's
 * roles only (a literal key, never a path), MCP permissions with the
 * catalog's implications, and a service only for a marked token of a
 * configured service-only client.
 */

import { describe, expect, it } from "vitest";
import {
    clientRoles,
    keycloakClaims,
    SERVICE_MARKER_CLAIM,
} from "@/lib/identity/providers/keycloak/claims";
import { keycloakRealmFromIssuer } from "@/lib/identity/providers/keycloak/config";

const provider = keycloakClaims({
    rolesClient: "chatterbox",
    mcpAudience: "chatterbox-mcp",
});

describe("Keycloak capabilities", () => {
    it("reads the roles client's catalog roles only", () => {
        const capabilities = provider.capabilitiesFromAccessToken({
            resource_access: {
                chatterbox: { roles: ["use", "org.curate", "admin", 7] },
                other: { roles: ["access.manage"] },
            },
            realm_access: { roles: ["access.manage"] },
        });
        expect([...capabilities].sort()).toEqual(["org.curate", "use"]);
    });

    it("treats a client id with dots or slashes as a literal key", () => {
        const dotted = keycloakClaims({
            rolesClient: "https://chatterbox.example/app",
            mcpAudience: null,
        });
        expect([
            ...dotted.capabilitiesFromAccessToken({
                resource_access: {
                    "https://chatterbox.example/app": { roles: ["use"] },
                    https: {
                        "chatterbox.example": { roles: ["access.manage"] },
                    },
                },
            }),
        ]).toEqual(["use"]);
        expect(
            clientRoles(
                { resource_access: { "a.b": { roles: ["use"] } } },
                "a",
            ),
        ).toEqual([]);
    });

    it("never reads inherited properties", () => {
        const payload = JSON.parse(
            '{"resource_access":{"__proto__":{"roles":["use"]}}}',
        );
        expect([...provider.capabilitiesFromAccessToken(payload)].length).toBe(
            0,
        );
        expect(clientRoles({}, "toString")).toEqual([]);
    });

    it("grants nothing when the claim is missing", () => {
        expect(provider.capabilitiesFromAccessToken({}).size).toBe(0);
    });
});

describe("Keycloak identity", () => {
    it("normalizes the verified ID token", () => {
        expect(
            provider.identityFromIdToken("https://kc/realms/a", {
                sub: "s1",
                email: "Ann@Example.TEST",
                email_verified: true,
                given_name: "Ann",
                family_name: "Example",
                auth_time: 1_700_000_000,
            }),
        ).toEqual({
            issuer: "https://kc/realms/a",
            subject: "s1",
            email: "ann@example.test",
            emailVerified: true,
            name: "Ann Example",
            authTime: new Date(1_700_000_000_000),
        });
    });

    it("treats anything but true as an unverified email", () => {
        expect(
            provider.identityFromIdToken("i", {
                sub: "s",
                email: "a@b.c",
                email_verified: "true",
            })?.emailVerified,
        ).toBe(false);
    });

    it("refuses a token without a subject", () => {
        expect(provider.identityFromIdToken("i", { email: "a@b.c" })).toBe(
            null,
        );
    });
});

describe("Keycloak MCP tokens", () => {
    const service = { serviceClients: ["chatterbox-bot"] };

    it("expands tasks:write to tasks:read", () => {
        const profile = provider.mcpTokenProfile(
            {
                azp: "claude",
                scope: "openid tasks:write use",
                resource_access: {
                    "chatterbox-mcp": { roles: ["tasks:write", "use"] },
                },
            },
            service,
        );
        expect([...profile.permissions].sort()).toEqual([
            "tasks:read",
            "tasks:write",
        ]);
        expect(profile.kind).toBe("user");
        expect(profile.clientId).toBe("claude");
    });

    it("does not promote a read scope using a write role", () => {
        const profile = provider.mcpTokenProfile(
            {
                scope: "openid tasks:read",
                resource_access: {
                    "chatterbox-mcp": { roles: ["tasks:write"] },
                },
            },
            service,
        );
        expect([...profile.permissions]).toEqual(["tasks:read"]);
        expect(
            provider.mcpTokenProfile(
                {
                    resource_access: {
                        "chatterbox-mcp": { roles: ["tasks:write"] },
                    },
                },
                service,
            ).permissions.size,
        ).toBe(0);
    });

    it("enforces provider token profiles", () => {
        expect(
            provider.acceptsAccessToken({ typ: "Bearer", azp: "web" }, "web"),
        ).toBe(true);
        expect(
            provider.acceptsAccessToken({ typ: "ID", azp: "web" }, "web"),
        ).toBe(false);
        expect(
            provider.acceptsAccessToken({ typ: "Bearer", azp: "agent" }, "web"),
        ).toBe(false);
        expect(provider.acceptsIdToken({ typ: "Bearer" }, "web")).toBe(false);
    });

    it("classifies a marked token of a configured service client as a service", () => {
        expect(
            provider.mcpTokenProfile(
                {
                    azp: "chatterbox-bot",
                    client_id: "chatterbox-bot",
                    [SERVICE_MARKER_CLAIM]: "service",
                },
                service,
            ).kind,
        ).toBe("service");
    });

    it.each([
        [
            "client_id alone",
            { azp: "chatterbox-bot", client_id: "chatterbox-bot" },
        ],
        [
            "a client outside MCP_SERVICE_CLIENTS",
            {
                azp: "other",
                client_id: "other",
                [SERVICE_MARKER_CLAIM]: "service",
            },
        ],
        [
            "a mismatched client_id",
            {
                azp: "chatterbox-bot",
                client_id: "other",
                [SERVICE_MARKER_CLAIM]: "service",
            },
        ],
        [
            "a wrong marker value",
            {
                azp: "chatterbox-bot",
                client_id: "chatterbox-bot",
                [SERVICE_MARKER_CLAIM]: "user",
            },
        ],
        [
            "a marker without client_id (a person's token)",
            { azp: "chatterbox-bot", [SERVICE_MARKER_CLAIM]: "service" },
        ],
    ])("does not make a service of %s", (_label, claims) => {
        expect(provider.mcpTokenProfile(claims, service).kind).toBe("user");
    });
});

describe("Keycloak realm from issuer", () => {
    it.each([
        [
            "https://id.example.com/realms/acme",
            { baseUrl: "https://id.example.com", realm: "acme" },
        ],
        [
            "http://keycloak:8080/auth/realms/acme/",
            { baseUrl: "http://keycloak:8080/auth", realm: "acme" },
        ],
        ["https://id.example.com/acme", null],
        ["not a url", null],
    ])("%s", (issuer, expected) => {
        expect(keycloakRealmFromIssuer(issuer)).toEqual(expected);
    });
});
