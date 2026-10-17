import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

const configuredMailEnv: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    NEXT_PHASE: "phase-production-build",
    OIDC_ISSUER_URL: "https://id.example.com/realms/acme",
    OIDC_CLIENT_ID: "riffado",
    OIDC_CLIENT_SECRET: "oidc-client-secret",
    MAIL_DOMAIN: "mail.example.com",
    MAIL_ORG_NICKNAME: "acme",
    MAIL_FORMER_ORG_NICKNAMES: "oldacme, legacy",
    MAIL_ADDRESS_HASH_SECRET: "address-hash-secret-at-least-32-characters",
    MAIL_INGEST_SECRET: "mail-ingest-secret-at-least-32-characters",
    MAIL_MAX_SIGNATURE_AGE_HOURS: "48",
    MAIL_DAILY_LIMIT: "750",
    MAIL_MAX_MESSAGE_MB: "42",
    MAIL_INACTIVE_DAYS: "90",
};

afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
});

describe("environment input mapping", () => {
    it("maps every schema key to explicit runtime input", async () => {
        process.env = {
            NODE_ENV: "test",
            NEXT_PHASE: "phase-production-build",
        };
        vi.resetModules();

        const { envSchemaKeys, readEnvInput } = await import("@/lib/env");

        expect(Object.keys(readEnvInput()).sort()).toEqual(
            [...envSchemaKeys].sort(),
        );
    });

    it("loads mail settings from process.env and enables mail only with a domain", async () => {
        process.env = { ...configuredMailEnv };
        vi.resetModules();

        const { env } = await import("@/lib/env");
        const { isMailEnabled } = await import("@/lib/mail/config");

        expect(env.MAIL_DOMAIN).toBe("mail.example.com");
        expect(env.MAIL_ORG_NICKNAME).toBe("acme");
        expect(env.MAIL_FORMER_ORG_NICKNAMES).toEqual(["oldacme", "legacy"]);
        expect(env.MAIL_ADDRESS_HASH_SECRET).toBe(
            configuredMailEnv.MAIL_ADDRESS_HASH_SECRET,
        );
        expect(env.MAIL_INGEST_SECRET).toBe(
            configuredMailEnv.MAIL_INGEST_SECRET,
        );
        expect(env.MAIL_MAX_SIGNATURE_AGE_HOURS).toBe(48);
        expect(env.MAIL_DAILY_LIMIT).toBe(750);
        expect(env.MAIL_MAX_MESSAGE_MB).toBe(42);
        expect(env.MAIL_INACTIVE_DAYS).toBe(90);
        expect(isMailEnabled()).toBe(true);

        delete process.env.MAIL_DOMAIN;
        vi.resetModules();

        const { isMailEnabled: isMailEnabledWithoutDomain } = await import(
            "@/lib/mail/config"
        );
        expect(isMailEnabledWithoutDomain()).toBe(false);
    });
});
