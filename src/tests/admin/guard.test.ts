import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
    headers: async () => new Headers(),
    cookies: async () => ({
        get: () => (state.cookie ? { value: state.cookie } : undefined),
    }),
}));
vi.mock("next/navigation", () => ({
    notFound: () => {
        throw new Error("NEXT_NOT_FOUND");
    },
}));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        ADMIN_EMAILS: [],
        ADMIN_IP_ALLOWLIST: [],
        ADMIN_REAUTH_TTL_MINUTES: 30,
        ADMIN_MUTATION_TTL_MINUTES: 10,
        BETTER_AUTH_SECRET: "better-auth-secret-with-32-chars",
    },
}));

vi.mock("@/db", () => ({
    db: {
        insert: vi.fn(),
    },
}));

vi.mock("@/lib/auth", () => ({
    auth: {
        api: {
            getSession: vi.fn(),
        },
    },
}));

import { db } from "@/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { ErrorCode } from "@/lib/errors";
import { signElevatedCookie } from "@/lib/hosted/admin/elevated-cookie";
import {
    requireAdminApi,
    requireAdminMutation,
    requireAdminPage,
} from "@/lib/hosted/admin/guard";

describe("admin API guard", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        env.IS_HOSTED = false;
        env.ADMIN_EMAILS = ["admin@example.com"];
        state.cookie = undefined;
        vi.mocked(auth.api.getSession).mockResolvedValue({
            user: { id: "admin-user", email: "admin@example.com" },
            session: { id: "session-current" },
        } as Awaited<ReturnType<typeof auth.api.getSession>>);
        vi.mocked(db.insert).mockReturnValue({
            values: vi.fn().mockResolvedValue(undefined),
        } as unknown as ReturnType<typeof db.insert>);
    });

    it("throws a JSON-mappable 404 AppError for failed API reads", async () => {
        await expect(
            requireAdminApi({
                route: "/api/admin/example",
                method: "GET",
            }),
        ).rejects.toMatchObject({
            code: ErrorCode.NOT_FOUND,
            statusCode: 404,
        });
    });

    it("throws a JSON-mappable 404 AppError for failed mutations", async () => {
        await expect(
            requireAdminMutation({
                route: "/api/admin/actions/example",
                method: "POST",
            }),
        ).rejects.toMatchObject({
            code: ErrorCode.NOT_FOUND,
            statusCode: 404,
        });
    });
});

describe("session-bound admin elevation", () => {
    beforeEach(() => {
        env.IS_HOSTED = true;
        env.ADMIN_EMAILS = ["admin@example.com"];
        vi.clearAllMocks();
        vi.mocked(auth.api.getSession).mockResolvedValue({
            user: { id: "admin-user", email: "admin@example.com" },
            session: { id: "session-current" },
        } as Awaited<ReturnType<typeof auth.api.getSession>>);
        vi.mocked(db.insert).mockReturnValue({
            values: vi.fn().mockResolvedValue(undefined),
        } as unknown as ReturnType<typeof db.insert>);
    });

    it("accepts reads and mutations in the elevated session", async () => {
        state.cookie = signElevatedCookie("admin-user", "session-current");
        await expect(
            requireAdminPage({ route: "/admin", method: "GET" }),
        ).resolves.toMatchObject({ mode: "ok" });
        await expect(
            requireAdminMutation({
                route: "/api/admin/actions/example",
                method: "POST",
            }),
        ).resolves.toMatchObject({ mode: "ok" });
    });

    it.each([
        "other-session",
        "tampered-session",
        "revoked-session",
        "missing-cookie",
    ])("requires reauth and refuses API calls for %s", async (scenario) => {
        state.cookie =
            scenario === "missing-cookie"
                ? undefined
                : signElevatedCookie("admin-user", "session-other");
        if (scenario === "tampered-session")
            state.cookie = state.cookie?.replace(
                "session-other",
                "session-current",
            );
        if (scenario === "revoked-session")
            vi.mocked(auth.api.getSession).mockResolvedValue(null);
        if (scenario === "revoked-session") {
            await expect(
                requireAdminPage({ route: "/admin", method: "GET" }),
            ).rejects.toThrow("NEXT_NOT_FOUND");
        } else {
            await expect(
                requireAdminPage({ route: "/admin", method: "GET" }),
            ).resolves.toMatchObject({ mode: "reauth" });
        }
        await expect(
            requireAdminApi({ route: "/api/admin/example", method: "GET" }),
        ).rejects.toMatchObject({ statusCode: 404 });
        await expect(
            requireAdminMutation({
                route: "/api/admin/actions/example",
                method: "POST",
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(db.insert).not.toHaveBeenCalled();
    });
});
