import { beforeEach, describe, expect, it, vi } from "vitest";
import { PUT as updateOrganization } from "@/app/api/settings/ai/organization-providers/[id]/route";
import { POST as createOrganization } from "@/app/api/settings/ai/organization-providers/route";
import { PUT as updatePersonal } from "@/app/api/settings/ai/providers/[id]/route";
import { POST as createPersonal } from "@/app/api/settings/ai/providers/route";
import { parseProviderMaxOutputTokens } from "@/lib/ai/provider-output-tokens";

const { create, update, transaction, select } = vi.hoisted(() => ({
    create: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
    select: vi.fn(),
}));

vi.mock("@/db", () => ({ db: { select, transaction } }));
vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: false } }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({
        user: { id: "user-1", email: "user@example.test" },
    }),
    requireApiSessionActor: async () => ({
        session: { user: { id: "user-1", email: "user@example.test" } },
        actor: { kind: "user", actorId: "user-1" },
    }),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/encryption", () => ({
    encrypt: (value: string) => `encrypted:${value}`,
}));
vi.mock("@/lib/profiles/organization-providers", () => ({
    createOrganizationProvider: create,
    updateOrganizationProvider: update,
    organizationProviderManageContext: async () => ({ orgUserId: "org-1" }),
    organizationAccountProviderAuditContext: async () => null,
    writeOrganizationProviderAudit: vi.fn(),
}));

function request(maxOutputTokens: unknown, update = false): Request {
    return new Request("https://app.example.test/api/settings/ai/providers", {
        method: "POST",
        body: JSON.stringify(
            update
                ? { maxOutputTokens }
                : {
                      provider: "Codex",
                      apiKey: "test-key",
                      defaultModel: "model",
                      maxOutputTokens,
                  },
        ),
    });
}

describe("provider output limit validation", () => {
    beforeEach(() => vi.clearAllMocks());

    it.each([
        255,
        200001,
        512.5,
        "1024",
        false,
        {},
        [],
    ])("rejects %j on all four mutation routes", async (value) => {
        const context = { params: Promise.resolve({ id: "card-1" }) };
        const responses = await Promise.all([
            createPersonal(request(value)),
            updatePersonal(request(value, true), context),
            createOrganization(request(value)),
            updateOrganization(request(value, true), context),
        ]);
        expect(responses.map((response) => response.status)).toEqual([
            400, 400, 400, 400,
        ]);
        const bodies = await Promise.all(
            responses.map((response) => response.json()),
        );
        expect(bodies).toEqual(
            Array.from({ length: 4 }, () => ({
                error: "Max output tokens must be a whole number from 256 to 200,000, or empty.",
                code: "INVALID_INPUT",
                details: { field: "maxOutputTokens" },
            })),
        );
        expect(transaction).not.toHaveBeenCalled();
        expect(select).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });

    it.each([
        256,
        200000,
        null,
    ])("forwards %j through Organization create and update", async (value) => {
        expect((await createOrganization(request(value))).status).toBe(200);
        expect(create).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ maxOutputTokens: value }),
        );
        expect(
            (
                await updateOrganization(request(value, true), {
                    params: Promise.resolve({ id: "card-1" }),
                })
            ).status,
        ).toBe(200);
        expect(update).toHaveBeenCalledWith(
            expect.anything(),
            "card-1",
            expect.objectContaining({ maxOutputTokens: value }),
        );
    });

    it("distinguishes omitted updates from clearing the cap", () => {
        expect(parseProviderMaxOutputTokens({})).toBeUndefined();
        expect(
            parseProviderMaxOutputTokens({ maxOutputTokens: null }),
        ).toBeNull();
    });
});
