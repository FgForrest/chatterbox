import { describe, expect, it, vi } from "vitest";

// `@/lib/auth-request` imports the db, auth and env modules for its
// `authenticateRequest` path. These scope helpers are pure, so stub the
// heavy dependencies that would otherwise validate env at import time.
vi.mock("@/lib/env", () => ({
    env: {
        BETTER_AUTH_SECRET: "test-secret-with-at-least-32-characters",
        API_TOKEN_HASH_SECRET: undefined,
    },
}));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));

import {
    type AuthenticatedRequest,
    hasApiScope,
    normalizeApiKeyScopes,
    requireApiScope,
} from "@/lib/auth-request";
import { AppError, ErrorCode } from "@/lib/errors";

describe("normalizeApiKeyScopes", () => {
    it("defaults to read", () => {
        expect(normalizeApiKeyScopes(undefined)).toEqual(["read"]);
        expect(normalizeApiKeyScopes([])).toEqual(["read"]);
        expect(normalizeApiKeyScopes("nonsense")).toEqual(["read"]);
    });

    it("keeps known scopes and drops unknown ones", () => {
        expect(normalizeApiKeyScopes(["recordings:write"])).toEqual([
            "recordings:write",
        ]);
        expect(
            normalizeApiKeyScopes(["read", "recordings:write", "admin"]),
        ).toEqual(["read", "recordings:write"]);
    });

    it("de-duplicates", () => {
        expect(normalizeApiKeyScopes(["read", "read"])).toEqual(["read"]);
    });
});

describe("hasApiScope", () => {
    it("grants a session every scope", () => {
        const session: AuthenticatedRequest = {
            user: { id: "u1" },
            via: "session",
        };
        expect(hasApiScope(session, "recordings:write")).toBe(true);
        expect(hasApiScope(session, "read")).toBe(true);
    });

    it("limits an API key to its scopes", () => {
        const key: AuthenticatedRequest = {
            user: { id: "u1" },
            via: "api-key",
            apiKeyId: "k1",
            scopes: ["read"],
        };
        expect(hasApiScope(key, "read")).toBe(true);
        expect(hasApiScope(key, "recordings:write")).toBe(false);
    });

    it("treats a scopeless key as read-only", () => {
        const key: AuthenticatedRequest = {
            user: { id: "u1" },
            via: "api-key",
            apiKeyId: "k1",
        };
        expect(hasApiScope(key, "recordings:write")).toBe(false);
    });
});

describe("requireApiScope", () => {
    it("throws a 403 when the scope is missing", () => {
        const key: AuthenticatedRequest = {
            user: { id: "u1" },
            via: "api-key",
            apiKeyId: "k1",
            scopes: ["read"],
        };
        try {
            requireApiScope(key, "recordings:write");
            expect.unreachable("should have thrown");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).code).toBe(ErrorCode.FORBIDDEN);
            expect((error as AppError).statusCode).toBe(403);
        }
    });

    it("passes when the scope is present", () => {
        const key: AuthenticatedRequest = {
            user: { id: "u1" },
            via: "api-key",
            apiKeyId: "k1",
            scopes: ["recordings:write"],
        };
        expect(() => requireApiScope(key, "recordings:write")).not.toThrow();
    });
});
