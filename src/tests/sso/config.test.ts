import { beforeEach, describe, expect, it, vi } from "vitest";

const { envMock } = vi.hoisted(() => ({
    envMock: {
        IS_HOSTED: false,
        OIDC_ISSUER_URL: undefined as string | undefined,
        OIDC_CLIENT_ID: undefined as string | undefined,
        OIDC_CLIENT_SECRET: undefined as string | undefined,
        SELF_HOST_MODE: "shared" as "shared" | "local",
        ORG_ACCOUNT_EMAIL: undefined as string | undefined,
        ORG_ACCOUNT_PASSWORD: undefined as string | undefined,
    },
}));
vi.mock("@/lib/env", () => ({ env: envMock }));
vi.mock("@/db", () => ({ db: {} }));

import { isOrgScopeEnabled } from "@/lib/org/config";
import {
    isSsoConfiguredButIgnored,
    isSsoEnabled,
    PASSWORD_AUTH_PATHS,
    ssoDiscoveryUrl,
} from "@/lib/sso/config";

function configure() {
    envMock.OIDC_ISSUER_URL = "https://idp.example.com/realms/acme";
    envMock.OIDC_CLIENT_ID = "riffado";
    envMock.OIDC_CLIENT_SECRET = "secret";
}

beforeEach(() => {
    envMock.IS_HOSTED = false;
    envMock.OIDC_ISSUER_URL = undefined;
    envMock.OIDC_CLIENT_ID = undefined;
    envMock.OIDC_CLIENT_SECRET = undefined;
    envMock.ORG_ACCOUNT_EMAIL = undefined;
    envMock.ORG_ACCOUNT_PASSWORD = undefined;
});

describe("isSsoEnabled", () => {
    it("is off without configuration", () => {
        expect(isSsoEnabled()).toBe(false);
    });

    it("is on for a configured self-host instance", () => {
        configure();
        expect(isSsoEnabled()).toBe(true);
        expect(isSsoConfiguredButIgnored()).toBe(false);
    });

    it("is off on hosted, which reports the ignored configuration", () => {
        configure();
        envMock.IS_HOSTED = true;
        expect(isSsoEnabled()).toBe(false);
        expect(isSsoConfiguredButIgnored()).toBe(true);
    });
});

describe("password endpoints switched off under SSO", () => {
    it.each([
        "/sign-in/email",
        "/sign-up/email",
        "/request-password-reset",
        "/reset-password",
        "/change-password",
        "/change-email",
        "/unlink-account",
    ])("includes %s", (path) => {
        expect(PASSWORD_AUTH_PATHS).toContain(path);
    });

    it("leaves sign-in through the provider and sign-out alone", () => {
        expect(PASSWORD_AUTH_PATHS).not.toContain("/sign-in/oauth2");
        expect(PASSWORD_AUTH_PATHS).not.toContain("/sign-out");
        expect(PASSWORD_AUTH_PATHS).not.toContain("/get-session");
    });
});

describe("ssoDiscoveryUrl", () => {
    it("appends the well-known path once", () => {
        expect(ssoDiscoveryUrl("https://idp.example.com/realms/acme/")).toBe(
            "https://idp.example.com/realms/acme/.well-known/openid-configuration",
        );
    });
});

describe("Organization scope under SSO", () => {
    it("needs no account password", () => {
        configure();
        envMock.ORG_ACCOUNT_EMAIL = "org@example.com";
        expect(isOrgScopeEnabled()).toBe(true);
    });

    it("still needs the password without SSO", () => {
        envMock.ORG_ACCOUNT_EMAIL = "org@example.com";
        expect(isOrgScopeEnabled()).toBe(false);
        envMock.ORG_ACCOUNT_PASSWORD = "long-enough-password";
        expect(isOrgScopeEnabled()).toBe(true);
    });
});
