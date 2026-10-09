/**
 * The MCP_* environment contract: the external MCP server is off unless an
 * audience is set, and then it needs single sign-on (its realm issues the
 * tokens) and a canonical APP_URL.
 */

import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
    // Import env.ts without its runtime checks (DATABASE_URL and friends).
    process.env.NEXT_PHASE = "phase-production-build";
});

import { envSchema } from "@/lib/env";

const base = { APP_URL: "https://riffado.example.com" };

const OIDC = {
    OIDC_ISSUER_URL: "https://id.example.com/realms/acme",
    OIDC_CLIENT_ID: "riffado",
    OIDC_CLIENT_SECRET: "secret",
};

const SSO_REQUIRED =
    "MCP_AUDIENCE needs single sign-on (OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET)";

function issuesOf(input: Record<string, string>): string[] {
    const result = envSchema.safeParse(input);
    return result.success
        ? []
        : result.error.issues.map((issue) => issue.message);
}

describe("MCP environment", () => {
    it("is off and has defaults when unset", () => {
        const parsed = envSchema.parse(base);
        expect(parsed.MCP_AUDIENCE).toBeUndefined();
        expect(parsed.MCP_ALLOWED_CLIENTS).toEqual([]);
        expect(parsed.MCP_AUDIT_RETENTION_DAYS).toBe(90);
    });

    it("reads the empty strings docker compose passes for unset values as unset", () => {
        const parsed = envSchema.parse({
            ...base,
            MCP_AUDIENCE: "",
            MCP_ALLOWED_CLIENTS: "",
            MCP_AUDIT_RETENTION_DAYS: "",
        });
        expect(parsed.MCP_AUDIENCE).toBeUndefined();
        expect(parsed.MCP_ALLOWED_CLIENTS).toEqual([]);
        expect(parsed.MCP_AUDIT_RETENTION_DAYS).toBe(90);
    });

    it("needs single sign-on when the audience is set", () => {
        expect(issuesOf({ ...base, MCP_AUDIENCE: "riffado-mcp" })).toContain(
            SSO_REQUIRED,
        );
    });

    it("needs the whole SSO client, not just the issuer", () => {
        expect(
            issuesOf({
                ...base,
                MCP_AUDIENCE: "riffado-mcp",
                OIDC_ISSUER_URL: OIDC.OIDC_ISSUER_URL,
            }),
        ).toContain(SSO_REQUIRED);
    });

    it("needs APP_URL when the audience is set", () => {
        expect(issuesOf({ ...OIDC, MCP_AUDIENCE: "riffado-mcp" })).toContain(
            "MCP_AUDIENCE needs APP_URL",
        );
    });

    it("accepts an audience with single sign-on and APP_URL", () => {
        expect(
            issuesOf({ ...base, ...OIDC, MCP_AUDIENCE: " riffado-mcp " }),
        ).toEqual([]);
        expect(
            envSchema.parse({ ...base, ...OIDC, MCP_AUDIENCE: " riffado-mcp " })
                .MCP_AUDIENCE,
        ).toBe("riffado-mcp");
    });

    it("accepts single sign-on on an internal host", () => {
        expect(
            issuesOf({
                ...base,
                ...OIDC,
                OIDC_ISSUER_URL: "http://keycloak:8080/realms/acme",
                MCP_AUDIENCE: "riffado-mcp",
            }),
        ).toEqual([]);
    });

    it("has no public entrance, connector keys or resource audience by default", () => {
        const parsed = envSchema.parse({
            ...base,
            MCP_PUBLIC_INGRESS_HEADER: "",
            MCP_PUBLIC_CLIENTS: "",
            MCP_CONNECTOR_KEYS: "",
            MCP_RESOURCE_AUDIENCE: "",
        });
        expect(parsed.MCP_PUBLIC_INGRESS_HEADER).toBeUndefined();
        expect(parsed.MCP_PUBLIC_CLIENTS).toEqual([]);
        expect(parsed.MCP_CONNECTOR_KEYS).toEqual([]);
        expect(parsed.MCP_RESOURCE_AUDIENCE).toBeUndefined();
    });

    it("reads the public entrance: a header name and its clients", () => {
        const parsed = envSchema.parse({
            ...base,
            MCP_PUBLIC_INGRESS_HEADER: " X-MCP-Ingress ",
            MCP_PUBLIC_CLIENTS: "claude, claude-jdoe",
        });
        expect(parsed.MCP_PUBLIC_INGRESS_HEADER).toBe("x-mcp-ingress");
        expect(parsed.MCP_PUBLIC_CLIENTS).toEqual(["claude", "claude-jdoe"]);
        expect(
            issuesOf({ ...base, MCP_PUBLIC_INGRESS_HEADER: "X MCP" }),
        ).toEqual(["MCP_PUBLIC_INGRESS_HEADER must be an HTTP header name"]);
    });

    it("needs the ingress header for public clients", () => {
        expect(issuesOf({ ...base, MCP_PUBLIC_CLIENTS: "claude" })).toEqual([
            "MCP_PUBLIC_CLIENTS needs MCP_PUBLIC_INGRESS_HEADER",
        ]);
    });

    it("reads connector keys as client=key pairs", () => {
        const key = "k".repeat(32);
        const padded = `${"a".repeat(30)}==`;
        const parsed = envSchema.parse({
            ...base,
            MCP_CONNECTOR_KEYS: ` claude = ${key} ,claude-jdoe=${padded}`,
        });
        expect(parsed.MCP_CONNECTOR_KEYS).toEqual([
            { client: "claude", key },
            { client: "claude-jdoe", key: padded },
        ]);
    });

    it("refuses a malformed, short or repeated connector key", () => {
        const key = "k".repeat(32);
        for (const value of [
            key,
            `=${key}`,
            "claude=short",
            `claude=${key},claude=${key}`,
        ]) {
            const issues = issuesOf({ ...base, MCP_CONNECTOR_KEYS: value });
            expect(issues).toHaveLength(1);
            expect(issues[0]).toMatch(/^MCP_CONNECTOR_KEYS must be/);
            expect(issues[0]).not.toContain(key);
        }
    });

    it("switches the resource audience strictly", () => {
        expect(
            envSchema.parse({ ...base, MCP_RESOURCE_AUDIENCE: "true" })
                .MCP_RESOURCE_AUDIENCE,
        ).toBe(true);
        expect(issuesOf({ ...base, MCP_RESOURCE_AUDIENCE: "yes" })).not.toEqual(
            [],
        );
    });

    it("splits the client allowlist", () => {
        const parsed = envSchema.parse({
            ...base,
            ...OIDC,
            MCP_AUDIENCE: "riffado-mcp",
            MCP_ALLOWED_CLIENTS: " claude , cursor ,,",
        });
        expect(parsed.MCP_ALLOWED_CLIENTS).toEqual(["claude", "cursor"]);
    });

    it("bounds the audit retention", () => {
        expect(
            envSchema.parse({ ...base, MCP_AUDIT_RETENTION_DAYS: " 30 " })
                .MCP_AUDIT_RETENTION_DAYS,
        ).toBe(30);
        expect(
            issuesOf({ ...base, MCP_AUDIT_RETENTION_DAYS: "0" }),
        ).not.toEqual([]);
        expect(
            issuesOf({ ...base, MCP_AUDIT_RETENTION_DAYS: "3651" }),
        ).not.toEqual([]);
        expect(
            issuesOf({ ...base, MCP_AUDIT_RETENTION_DAYS: "90d" }),
        ).not.toEqual([]);
    });
});
