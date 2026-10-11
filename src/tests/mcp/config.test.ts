import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
    IS_HOSTED: false,
    MCP_AUDIENCE: undefined as string | undefined,
    MCP_ALLOWED_CLIENTS: [] as string[],
    MCP_PUBLIC_CLIENTS: [] as string[],
    MCP_CONNECTOR_KEYS: [] as { client: string; key: string }[],
    OIDC_ISSUER_URL: undefined as string | undefined,
    OIDC_CLIENT_ID: undefined as string | undefined,
    OIDC_CLIENT_SECRET: undefined as string | undefined,
}));

vi.mock("@/lib/env", () => ({ env: mockEnv }));

import {
    isMcpEnabled,
    issuerMetadata,
    mcpConfigWarnings,
} from "@/lib/mcp/config";

let issuerCounter = 0;

/** A fresh issuer URL per test, so the per-URL discovery cache starts empty. */
function freshIssuer(): string {
    issuerCounter += 1;
    return `http://keycloak:8080/realms/acme-${issuerCounter}`;
}

function configureSso(issuer = "https://id.example.com/realms/acme"): void {
    mockEnv.OIDC_ISSUER_URL = issuer;
    mockEnv.OIDC_CLIENT_ID = "riffado";
    mockEnv.OIDC_CLIENT_SECRET = "secret";
}

function resetEnv(): void {
    mockEnv.IS_HOSTED = false;
    mockEnv.MCP_AUDIENCE = undefined;
    mockEnv.MCP_ALLOWED_CLIENTS = [];
    mockEnv.MCP_PUBLIC_CLIENTS = [];
    mockEnv.MCP_CONNECTOR_KEYS = [];
    mockEnv.OIDC_ISSUER_URL = undefined;
    mockEnv.OIDC_CLIENT_ID = undefined;
    mockEnv.OIDC_CLIENT_SECRET = undefined;
}

describe("isMcpEnabled", () => {
    beforeEach(resetEnv);

    it("is off without an audience", () => {
        configureSso();
        expect(isMcpEnabled()).toBe(false);
    });

    it("is off without single sign-on", () => {
        mockEnv.MCP_AUDIENCE = "riffado-mcp";
        expect(isMcpEnabled()).toBe(false);
    });

    it("is off with only the SSO issuer and no client", () => {
        mockEnv.MCP_AUDIENCE = "riffado-mcp";
        mockEnv.OIDC_ISSUER_URL = "https://id.example.com/realms/acme";
        expect(isMcpEnabled()).toBe(false);
    });

    it("is on with an audience and single sign-on", () => {
        mockEnv.MCP_AUDIENCE = "riffado-mcp";
        configureSso();
        expect(isMcpEnabled()).toBe(true);
    });

    it("is off on hosted, which ignores single sign-on", () => {
        mockEnv.IS_HOSTED = true;
        mockEnv.MCP_AUDIENCE = "riffado-mcp";
        configureSso();
        expect(isMcpEnabled()).toBe(false);
    });
});

describe("mcpConfigWarnings", () => {
    beforeEach(() => {
        resetEnv();
        mockEnv.MCP_AUDIENCE = "riffado-mcp";
        configureSso();
    });

    it("says nothing while the server is off", () => {
        mockEnv.MCP_AUDIENCE = undefined;
        expect(mcpConfigWarnings()).toEqual([]);
    });

    it("warns that an empty allowlist admits every client", () => {
        expect(mcpConfigWarnings()).toEqual([
            expect.stringContaining("MCP_ALLOWED_CLIENTS is empty"),
        ]);
    });

    it("names public or keyed clients the allowlist refuses anyway", () => {
        mockEnv.MCP_ALLOWED_CLIENTS = ["claude", "claude-code"];
        mockEnv.MCP_PUBLIC_CLIENTS = ["claude", "claude-jdoe"];
        mockEnv.MCP_CONNECTOR_KEYS = [
            { client: "claude", key: "k".repeat(32) },
            { client: "claude-jdoe", key: "j".repeat(32) },
        ];
        const warnings = mcpConfigWarnings();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("does not list claude-jdoe:");
        expect(warnings[0]).not.toContain("k".repeat(32));
    });

    it("is quiet when the allowlist covers them", () => {
        mockEnv.MCP_ALLOWED_CLIENTS = ["claude"];
        mockEnv.MCP_PUBLIC_CLIENTS = ["claude"];
        expect(mcpConfigWarnings()).toEqual([]);
    });
});

describe("issuerMetadata", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    beforeEach(() => {
        fetchSpy.mockReset();
        resetEnv();
        mockEnv.MCP_AUDIENCE = "riffado-mcp";
    });

    it("rejects when no issuer is configured", async () => {
        await expect(issuerMetadata()).rejects.toThrow(
            "MCP issuer is not configured",
        );
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("discovers the SSO realm at OIDC_ISSUER_URL, once per issuer URL", async () => {
        const url = freshIssuer();
        configureSso(url);
        fetchSpy.mockResolvedValue(
            Response.json({
                issuer: "https://id.example.com/realms/acme",
                jwks_uri: `${url}/protocol/openid-connect/certs`,
            }),
        );

        const first = await issuerMetadata();
        const second = await issuerMetadata();

        expect(first).toEqual({
            issuer: "https://id.example.com/realms/acme",
            jwksUri: `${url}/protocol/openid-connect/certs`,
        });
        expect(second).toEqual(first);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
            `${url}/.well-known/openid-configuration`,
        );
    });

    it("fetches again after a failure", async () => {
        const url = freshIssuer();
        configureSso(url);
        fetchSpy.mockResolvedValueOnce(new Response(null, { status: 503 }));
        await expect(issuerMetadata()).rejects.toThrow("discovery 503");

        fetchSpy.mockResolvedValueOnce(
            Response.json({
                issuer: url,
                jwks_uri: `${url}/certs`,
            }),
        );
        await expect(issuerMetadata()).resolves.toEqual({
            issuer: url,
            jwksUri: `${url}/certs`,
        });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it.each([
        [{ issuer: "https://id.example.com/realms/acme" }],
        [{ jwks_uri: "https://id.example.com/certs" }],
        [{ issuer: "https://id.example.com", jwks_uri: "file:///etc/passwd" }],
        [{ issuer: "", jwks_uri: "https://id.example.com/certs" }],
    ])("rejects an unusable discovery document (%j)", async (document) => {
        configureSso(freshIssuer());
        fetchSpy.mockResolvedValueOnce(Response.json(document));
        await expect(issuerMetadata()).rejects.toThrow(
            "discovery document lacks issuer or jwks_uri",
        );
    });
});
