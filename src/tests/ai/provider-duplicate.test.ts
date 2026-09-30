import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: { IS_HOSTED: false },
}));

vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));

vi.mock("@/lib/encryption", () => ({
    encrypt: vi.fn((plaintext: string) => `encrypted:${plaintext}`),
    decrypt: vi.fn(),
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

vi.mock("@/db", () => ({
    db: { select: vi.fn(), transaction: vi.fn() },
}));

vi.mock("@/lib/ai/set-default-transcription", () => ({
    setDefaultTranscriptionProvider: vi.fn().mockResolvedValue(undefined),
}));

import { POST as addProvider } from "@/app/api/settings/ai/providers/route";
import { db } from "@/db";
import { decrypt, encrypt } from "@/lib/encryption";

/** One `db.select()...limit(1)` result. */
function queueSelect(rows: unknown[]) {
    (db.select as Mock).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(rows),
            }),
        }),
    });
}

function post(body: Record<string, unknown>) {
    return addProvider(
        new Request("https://app.example.com/api/settings/ai/providers", {
            method: "POST",
            body: JSON.stringify(body),
        }),
    );
}

/**
 * Duplicating a provider saves a second model on the key the user already
 * stored -- the point being a second Claude Code or Codex model without a
 * second token. The key must travel as ciphertext only, and only between
 * rows of the same provider and the same user.
 */
describe("POST /api/settings/ai/providers with copyKeyFrom", () => {
    let inserted: Record<string, unknown> | undefined;

    beforeEach(() => {
        vi.clearAllMocks();
        inserted = undefined;
        (db.transaction as Mock).mockImplementation(
            async (fn: (tx: unknown) => Promise<unknown>) =>
                fn({
                    update: () => ({
                        set: () => ({
                            where: vi.fn().mockResolvedValue(undefined),
                        }),
                    }),
                    insert: () => ({
                        values: (values: Record<string, unknown>) => {
                            inserted = values;
                            return {
                                returning: vi
                                    .fn()
                                    .mockResolvedValue([{ id: "cred-2" }]),
                            };
                        },
                    }),
                }),
        );
    });

    it("stores the original's ciphertext without decrypting it", async () => {
        queueSelect([{ provider: "Claude Code", apiKey: "iv:tag:secret" }]);

        const response = await post({
            provider: "Claude Code",
            copyKeyFrom: "cred-1",
            baseUrl: "http://agent-bridge:8787/v1",
            defaultModel: "claude-opus-5-5",
        });

        expect(response.status).toBe(200);
        expect(inserted).toMatchObject({
            userId: "user-1",
            provider: "Claude Code",
            apiKey: "iv:tag:secret",
            defaultModel: "claude-opus-5-5",
            isDefaultTranscription: false,
            isDefaultEnhancement: false,
        });
        expect(decrypt).not.toHaveBeenCalled();
        expect(encrypt).not.toHaveBeenCalled();
    });

    it("prefers a key typed into the form over the copied one", async () => {
        const response = await post({
            provider: "Codex",
            apiKey: "new-token",
            copyKeyFrom: "cred-1",
        });

        expect(response.status).toBe(200);
        expect(inserted?.apiKey).toBe("encrypted:new-token");
        expect(db.select).not.toHaveBeenCalled();
    });

    it("refuses a source the user does not own", async () => {
        // The lookup is scoped by user id, so another user's row reads
        // as missing.
        queueSelect([]);

        const response = await post({
            provider: "Claude Code",
            copyKeyFrom: "someone-elses",
        });

        expect(response.status).toBe(404);
        expect(db.transaction).not.toHaveBeenCalled();
    });

    it("refuses to carry a key to another provider", async () => {
        queueSelect([{ provider: "OpenAI", apiKey: "iv:tag:sk" }]);

        const response = await post({
            provider: "Groq",
            copyKeyFrom: "cred-1",
        });
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.details).toEqual({ field: "provider" });
        expect(db.transaction).not.toHaveBeenCalled();
    });

    it("still requires a key when there is nothing to copy", async () => {
        const response = await post({ provider: "Claude Code" });

        expect(response.status).toBe(400);
        expect(db.select).not.toHaveBeenCalled();
    });

    it("keeps the capability guards: a Claude Code copy cannot transcribe", async () => {
        queueSelect([{ provider: "Claude Code", apiKey: "iv:tag:secret" }]);

        const response = await post({
            provider: "Claude Code",
            copyKeyFrom: "cred-1",
            isDefaultTranscription: true,
        });

        expect(response.status).toBe(400);
        expect(db.transaction).not.toHaveBeenCalled();
    });
});
