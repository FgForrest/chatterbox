import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv, config } = vi.hoisted(() => ({
    mockEnv: { APP_URL: "https://riffado.example.com/" as string | undefined },
    config: {
        isMcpEnabled: vi.fn<() => boolean>(),
        issuerMetadata:
            vi.fn<() => Promise<{ issuer: string; jwksUri: string }>>(),
    },
}));

vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/mcp/config", () => config);

import { GET as getMcpMetadata } from "@/app/.well-known/oauth-protected-resource/api/mcp/route";
import { GET as getRootMetadata } from "@/app/.well-known/oauth-protected-resource/route";
import {
    mcpResourceUrl,
    protectedResourceMetadata,
    resourceMetadataUrl,
    unauthorized,
} from "@/lib/mcp/metadata";

const ISSUER = "https://id.example.com/realms/acme";

describe("protected-resource metadata", () => {
    beforeEach(() => {
        mockEnv.APP_URL = "https://riffado.example.com/";
        config.isMcpEnabled.mockReset().mockReturnValue(true);
        config.issuerMetadata.mockReset().mockResolvedValue({
            issuer: ISSUER,
            jwksUri: "http://keycloak:8080/realms/acme/certs",
        });
    });

    it("names the resource under APP_URL", () => {
        expect(mcpResourceUrl()).toBe("https://riffado.example.com/api/mcp");
        expect(resourceMetadataUrl()).toBe(
            "https://riffado.example.com/.well-known/oauth-protected-resource/api/mcp",
        );
    });

    it("is not there while MCP is off", async () => {
        config.isMcpEnabled.mockReturnValue(false);
        const response = await protectedResourceMetadata();
        expect(response.status).toBe(404);
        expect(config.issuerMetadata).not.toHaveBeenCalled();
    });

    it("points at the discovered issuer", async () => {
        const response = await protectedResourceMetadata();
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe(
            "public, max-age=300",
        );
        await expect(response.json()).resolves.toEqual({
            resource: "https://riffado.example.com/api/mcp",
            authorization_servers: [ISSUER],
            scopes_supported: ["openid"],
            bearer_methods_supported: ["header"],
            resource_name: "Riffado",
        });
    });

    it("answers 503 while the realm cannot be discovered", async () => {
        config.issuerMetadata.mockRejectedValue(new Error("discovery 502"));
        const response = await protectedResourceMetadata();
        expect(response.status).toBe(503);
    });

    it("serves the same document at both well-known paths", async () => {
        const root = await getRootMetadata();
        const scoped = await getMcpMetadata();
        expect(root.status).toBe(200);
        expect(scoped.status).toBe(200);
        await expect(root.json()).resolves.toEqual(await scoped.json());
    });

    it("answers 401 pointing the client at the metadata and the scope", async () => {
        const response = unauthorized();
        expect(response.status).toBe(401);
        expect(response.headers.get("WWW-Authenticate")).toBe(
            'Bearer resource_metadata="https://riffado.example.com/.well-known/oauth-protected-resource/api/mcp", scope="openid"',
        );
        await expect(response.json()).resolves.toEqual({
            error: "Unauthorized",
        });
    });

    it("says invalid_token for a token it did not accept", () => {
        expect(unauthorized(true).headers.get("WWW-Authenticate")).toBe(
            'Bearer error="invalid_token", resource_metadata="https://riffado.example.com/.well-known/oauth-protected-resource/api/mcp", scope="openid"',
        );
    });
});
