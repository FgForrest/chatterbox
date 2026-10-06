/**
 * The OIDC_* environment contract: single sign-on is all-or-nothing, the
 * scopes always include `openid`, and the organization account needs no
 * password under SSO.
 */

import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
    // Import env.ts without its runtime checks (DATABASE_URL and friends).
    process.env.NEXT_PHASE = "phase-production-build";
});

import { envSchema } from "@/lib/env";

const OIDC = {
    OIDC_ISSUER_URL: "https://idp.example.com/realms/acme/",
    OIDC_CLIENT_ID: "riffado",
    OIDC_CLIENT_SECRET: "secret",
};

function issuesOf(input: Record<string, string>): string[] {
    const result = envSchema.safeParse(input);
    return result.success
        ? []
        : result.error.issues.map((issue) => issue.message);
}

describe("OIDC environment", () => {
    it("is off and has defaults when unset", () => {
        const parsed = envSchema.parse({});
        expect(parsed.OIDC_ISSUER_URL).toBeUndefined();
        expect(parsed.OIDC_PROVIDER_NAME).toBe("SSO");
        expect(parsed.OIDC_SCOPES).toEqual(["openid", "profile", "email"]);
        expect(parsed.OIDC_SESSION_MAX_AGE).toBe(24 * 60 * 60);
    });

    it("reads the empty strings docker compose passes for unset values as unset", () => {
        const parsed = envSchema.parse({
            OIDC_ISSUER_URL: "",
            OIDC_CLIENT_ID: "",
            OIDC_CLIENT_SECRET: "",
            OIDC_PROVIDER_NAME: "",
            OIDC_SCOPES: "",
            OIDC_SESSION_MAX_AGE: "",
        });
        expect(parsed.OIDC_ISSUER_URL).toBeUndefined();
        expect(parsed.OIDC_PROVIDER_NAME).toBe("SSO");
        expect(parsed.OIDC_SCOPES).toEqual(["openid", "profile", "email"]);
        expect(parsed.OIDC_SESSION_MAX_AGE).toBe(24 * 60 * 60);
    });

    it("trims the issuer's trailing slash", () => {
        const parsed = envSchema.parse(OIDC);
        expect(parsed.OIDC_ISSUER_URL).toBe(
            "https://idp.example.com/realms/acme",
        );
    });

    it.each([
        ["issuer", "OIDC_ISSUER_URL"],
        ["client id", "OIDC_CLIENT_ID"],
        ["client secret", "OIDC_CLIENT_SECRET"],
    ])("rejects a configuration without its %s", (_label, missing) => {
        const input: Record<string, string> = { ...OIDC };
        delete input[missing];
        expect(issuesOf(input)).toContain(
            "OIDC_ISSUER_URL, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET must be set together",
        );
    });

    it("rejects an issuer that is not an http(s) URL", () => {
        expect(
            issuesOf({ ...OIDC, OIDC_ISSUER_URL: "idp.example.com" }),
        ).toContain("OIDC_ISSUER_URL must be an http(s) URL");
    });

    it.each([
        "http://idp.example.com/realms/acme",
        "http://8.8.8.8/realms/acme",
    ])("rejects plain http to a public host (%s)", (issuer) => {
        expect(issuesOf({ ...OIDC, OIDC_ISSUER_URL: issuer })).toContain(
            "OIDC_ISSUER_URL must use https unless the provider is on an internal host",
        );
    });

    it.each([
        "http://keycloak:8080/realms/acme",
        "http://localhost:8180/realms/acme",
        "http://127.0.0.1:8180/realms/acme",
        "http://[::1]:8180/realms/acme",
        "http://10.1.2.3/realms/acme",
        "http://172.20.0.5/realms/acme",
        "http://192.168.1.10/realms/acme",
        "http://sso.corp.internal/realms/acme",
        "http://sso.local/realms/acme",
    ])("accepts plain http to an internal host (%s)", (issuer) => {
        expect(issuesOf({ ...OIDC, OIDC_ISSUER_URL: issuer })).toEqual([]);
    });

    it("rejects http to a public address that only looks private", () => {
        expect(
            issuesOf({
                ...OIDC,
                OIDC_ISSUER_URL: "http://172.32.0.1/realms/a",
            }),
        ).not.toEqual([]);
        expect(
            issuesOf({
                ...OIDC,
                OIDC_ISSUER_URL: "http://10.example.com/realms/a",
            }),
        ).not.toEqual([]);
    });

    it("always requests openid and accepts space or comma separators", () => {
        expect(
            envSchema.parse({ OIDC_SCOPES: "email, profile groups" })
                .OIDC_SCOPES,
        ).toEqual(["openid", "email", "profile", "groups"]);
        expect(
            envSchema.parse({ OIDC_SCOPES: "openid email" }).OIDC_SCOPES,
        ).toEqual(["openid", "email"]);
    });

    it("bounds the session lifetime", () => {
        expect(
            envSchema.parse({ OIDC_SESSION_MAX_AGE: "3600" })
                .OIDC_SESSION_MAX_AGE,
        ).toBe(3600);
        expect(issuesOf({ OIDC_SESSION_MAX_AGE: "60" })).not.toEqual([]);
        expect(issuesOf({ OIDC_SESSION_MAX_AGE: "1h" })).not.toEqual([]);
    });
});

describe("organization account password under SSO", () => {
    const PAIR_MESSAGE =
        "ORG_ACCOUNT_EMAIL and ORG_ACCOUNT_PASSWORD must be set together";

    it("is optional on a self-host instance with SSO", () => {
        expect(
            issuesOf({ ...OIDC, ORG_ACCOUNT_EMAIL: "org@example.com" }),
        ).toEqual([]);
    });

    it("is still required without SSO", () => {
        expect(issuesOf({ ORG_ACCOUNT_EMAIL: "org@example.com" })).toContain(
            PAIR_MESSAGE,
        );
    });

    it("is still required on hosted, which ignores SSO", () => {
        expect(
            issuesOf({
                ...OIDC,
                IS_HOSTED: "true",
                ORG_ACCOUNT_EMAIL: "org@example.com",
            }),
        ).toContain(PAIR_MESSAGE);
    });

    it("never stands without the email", () => {
        expect(
            issuesOf({ ...OIDC, ORG_ACCOUNT_PASSWORD: "long-enough-password" }),
        ).toContain(PAIR_MESSAGE);
    });
});
