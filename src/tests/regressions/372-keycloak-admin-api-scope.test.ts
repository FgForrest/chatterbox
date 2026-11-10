import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keycloakAdmin } from "@/lib/identity/providers/keycloak/admin";
import type { KeycloakConfig } from "@/lib/identity/providers/keycloak/config";
import { createKeycloakHttp } from "@/lib/identity/providers/keycloak/http";
import { keycloakVerifier } from "@/lib/identity/providers/keycloak/verifier";

const config: KeycloakConfig = {
    baseUrl: "https://sso.example.com",
    realm: "chatterbox-test",
    rolesClient: "chatterbox",
    mcpAudience: "chatterbox-mcp",
    groups: {
        use: "users-group",
        "org.curate": "curators-group",
        "access.manage": "admins-group",
    },
    verifier: {
        clientId: "chatterbox-verifier",
        clientSecret: "verifier-secret",
    },
};

let testTime = 0;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(testTime);
});

afterEach(() => {
    testTime = Date.now() + 10 * 60 * 1000;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("Keycloak Admin API audience diagnostics (#372)", () => {
    it.each([
        "verifier",
        "access management",
    ])("warns on an Admin API 401 for %s without exposing request data", async (caller) => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        const fetchMock = vi.spyOn(globalThis, "fetch");
        if (caller === "verifier") {
            fetchMock.mockResolvedValueOnce(
                Response.json({
                    access_token: "verifier-token",
                    expires_in: 300,
                }),
            );
        }
        fetchMock.mockResolvedValueOnce(
            new Response("sensitive provider response", { status: 401 }),
        );

        const result =
            caller === "verifier"
                ? keycloakVerifier(config).verify("subject-id")
                : keycloakAdmin(
                      config,
                      async () => "administrator-token",
                  ).listSubjects({
                      search: "person@example.com",
                      first: 0,
                      max: 10,
                  });

        await expect(result).rejects.toMatchObject({
            name: "IdentityProviderError",
            kind: "unauthorized",
            status: 401,
            message:
                "The identity provider did not accept the administrator's token",
        });
        expect(warning).toHaveBeenCalledExactlyOnceWith(
            "[keycloak] Admin API returned 401: the token may lack the Admin API audience and kc-admin-api client scope required on Keycloak 26.8+. Assign kc-admin-api as a default client scope to the verifier client and the web client used for access management.",
        );
        expect(fetchMock).toHaveBeenCalledTimes(caller === "verifier" ? 2 : 1);
    });

    it("throttles 100 Admin API 401 hints across clients for ten minutes", async () => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockImplementation(
                async () => new Response(null, { status: 401 }),
            );
        const request = () =>
            createKeycloakHttp({
                baseUrl: config.baseUrl,
                realm: config.realm,
                token: async () => "administrator-token",
            }).get("/users");

        await Promise.all(
            Array.from({ length: 100 }, () =>
                expect(request()).rejects.toMatchObject({
                    kind: "unauthorized",
                    status: 401,
                }),
            ),
        );
        expect(warning).toHaveBeenCalledOnce();
        expect(fetchMock).toHaveBeenCalledTimes(100);

        vi.advanceTimersByTime(10 * 60 * 1000 - 1);
        await expect(request()).rejects.toMatchObject({
            kind: "unauthorized",
            status: 401,
        });
        expect(warning).toHaveBeenCalledOnce();

        vi.advanceTimersByTime(1);
        await expect(request()).rejects.toMatchObject({
            kind: "unauthorized",
            status: 401,
        });
        expect(warning).toHaveBeenCalledTimes(2);
        expect(warning.mock.calls[1]).toEqual(warning.mock.calls[0]);
        expect(fetchMock).toHaveBeenCalledTimes(102);
    });

    it("does not suggest an audience fix for a token endpoint 401", async () => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response(null, { status: 401 }));

        await expect(
            keycloakVerifier(config).verify("subject-id"),
        ).rejects.toMatchObject({
            kind: "unauthorized",
            status: 401,
            message: "The access verifier could not obtain a token",
        });
        expect(warning).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("keeps an Admin API 403 distinct from a missing audience", async () => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(null, { status: 403 }),
        );

        await expect(
            keycloakAdmin(
                config,
                async () => "administrator-token",
            ).listSubjects({
                first: 0,
                max: 10,
            }),
        ).rejects.toMatchObject({ kind: "forbidden", status: 403 });
        expect(warning).not.toHaveBeenCalled();
    });
});
