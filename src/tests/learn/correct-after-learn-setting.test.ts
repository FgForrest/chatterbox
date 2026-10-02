/**
 * `PUT /api/settings/user` for the correction pass's switch: stored as
 * sent.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// The route says whether automatic Learn is offered here.
vi.mock("@/lib/knowledge/availability", () => ({
    isAutoLearnOffered: async () => false,
}));

vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (v: string) => v,
    encryptText: (v: string) => `enc(${v})`,
    decryptJsonField: <T>(v: T) => v,
    // Tagged so a test can tell an encrypted write from a raw one.
    encryptJsonField: <T>(v: T) => ({ encrypted: v }),
}));

const { updates } = vi.hoisted(() => ({
    updates: [] as Record<string, unknown>[],
}));

vi.mock("@/db", () => {
    const selectChain = {
        from: () => selectChain,
        where: () => selectChain,
        limit: () => Promise.resolve([{ userId: "user-1" }]),
    };
    return {
        db: {
            select: () => selectChain,
            update: () => ({
                set: (data: Record<string, unknown>) => {
                    updates.push(data);
                    return { where: () => Promise.resolve() };
                },
            }),
        },
    };
});

async function put(body: Record<string, unknown>) {
    const { PUT } = await import("@/app/api/settings/user/route");
    return PUT(
        new Request("http://localhost/api/settings/user", {
            method: "PUT",
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
        }),
    );
}

describe("PUT /api/settings/user — correcting after Learn", () => {
    beforeEach(() => {
        updates.length = 0;
    });

    it("stores the switch", async () => {
        const res = await put({ correctAfterLearn: false });
        expect(res.status).toBe(200);
        expect(updates.at(-1)).toHaveProperty("correctAfterLearn", false);
    });
});
