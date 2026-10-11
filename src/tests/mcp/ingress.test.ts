import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
    MCP_PUBLIC_INGRESS_HEADER: undefined as string | undefined,
    MCP_PUBLIC_CLIENTS: [] as string[],
    MCP_CONNECTOR_KEYS: [] as { client: string; key: string }[],
}));

vi.mock("@/lib/env", () => ({ env: mockEnv }));

import { ingressRefusal, viaPublicIngress } from "@/lib/mcp/ingress";

const KEY = "0123456789abcdef0123456789abcdef";

function request(headers: Record<string, string> = {}): Request {
    return new Request("http://localhost/api/mcp", {
        method: "POST",
        headers,
    });
}

describe("MCP entrance", () => {
    beforeEach(() => {
        mockEnv.MCP_PUBLIC_INGRESS_HEADER = undefined;
        mockEnv.MCP_PUBLIC_CLIENTS = [];
        mockEnv.MCP_CONNECTOR_KEYS = [];
    });

    it("serves every client while nothing is configured", () => {
        expect(viaPublicIngress(request({ "x-mcp-ingress": "public" }))).toBe(
            false,
        );
        for (const client of ["claude", "claude-code", null]) {
            expect(ingressRefusal(request(), client)).toBeNull();
        }
    });

    it("tells the public entrance by its marker header, whatever its value", () => {
        mockEnv.MCP_PUBLIC_INGRESS_HEADER = "x-mcp-ingress";
        expect(viaPublicIngress(request({ "X-MCP-Ingress": "public" }))).toBe(
            true,
        );
        expect(viaPublicIngress(request({ "x-mcp-ingress": "" }))).toBe(true);
        expect(viaPublicIngress(request())).toBe(false);
    });

    it("serves only the public clients through the public entrance", () => {
        mockEnv.MCP_PUBLIC_INGRESS_HEADER = "x-mcp-ingress";
        mockEnv.MCP_PUBLIC_CLIENTS = ["claude", "claude-jdoe"];
        const outside = request({ "x-mcp-ingress": "public" });
        expect(ingressRefusal(outside, "claude")).toBeNull();
        expect(ingressRefusal(outside, "claude-jdoe")).toBeNull();
        expect(ingressRefusal(outside, "claude-code")).toBe(
            "client-not-public",
        );
        expect(ingressRefusal(outside, null)).toBe("client-not-public");
        expect(ingressRefusal(request(), "claude-code")).toBeNull();
    });

    it("refuses every client through a public entrance without public clients", () => {
        mockEnv.MCP_PUBLIC_INGRESS_HEADER = "x-mcp-ingress";
        expect(
            ingressRefusal(request({ "x-mcp-ingress": "public" }), "claude"),
        ).toBe("client-not-public");
    });

    it("wants a keyed client's key, whichever way it came in", () => {
        mockEnv.MCP_CONNECTOR_KEYS = [{ client: "claude", key: KEY }];
        expect(ingressRefusal(request({ "x-api-key": KEY }), "claude")).toBe(
            null,
        );
        expect(ingressRefusal(request({ "X-API-Key": KEY }), "claude")).toBe(
            null,
        );
        const attempts: Record<string, string>[] = [
            {},
            { "x-api-key": "" },
            { "x-api-key": `${KEY}x` },
            { "x-api-key": KEY.slice(1) },
            { authorization: KEY },
        ];
        for (const headers of attempts) {
            expect(ingressRefusal(request(headers), "claude")).toBe(
                "connector-key",
            );
        }
        expect(ingressRefusal(request(), "claude-code")).toBeNull();
        expect(ingressRefusal(request(), null)).toBeNull();
    });

    it("checks each client against its own key", () => {
        const other = "fedcba9876543210fedcba9876543210";
        mockEnv.MCP_CONNECTOR_KEYS = [
            { client: "claude", key: KEY },
            { client: "claude-jdoe", key: other },
        ];
        expect(ingressRefusal(request({ "x-api-key": other }), "claude")).toBe(
            "connector-key",
        );
        expect(
            ingressRefusal(request({ "x-api-key": other }), "claude-jdoe"),
        ).toBeNull();
    });

    it("refuses a client outside the public list before looking at keys", () => {
        mockEnv.MCP_PUBLIC_INGRESS_HEADER = "x-mcp-ingress";
        mockEnv.MCP_PUBLIC_CLIENTS = ["claude"];
        mockEnv.MCP_CONNECTOR_KEYS = [{ client: "claude", key: KEY }];
        const outside = { "x-mcp-ingress": "public" };
        expect(
            ingressRefusal(request({ ...outside, "x-api-key": KEY }), "claude"),
        ).toBeNull();
        expect(ingressRefusal(request(outside), "claude")).toBe(
            "connector-key",
        );
        expect(
            ingressRefusal(
                request({ ...outside, "x-api-key": KEY }),
                "claude-code",
            ),
        ).toBe("client-not-public");
    });
});
