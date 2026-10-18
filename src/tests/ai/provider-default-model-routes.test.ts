import { beforeEach, describe, expect, it, vi } from "vitest";

const { createOrganizationProvider, transaction } = vi.hoisted(() => ({
    createOrganizationProvider: vi.fn(),
    transaction: vi.fn(),
}));

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
        transaction,
    },
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({
        user: { id: "user-1", email: "user@example.com" },
    }),
    requireApiSessionActor: vi.fn().mockResolvedValue({
        session: { user: { id: "user-1", email: "user@example.com" } },
        actor: { kind: "user", actorId: "user-1" },
    }),
}));

vi.mock("@/lib/ai/default-provider", () => ({
    loadDefaultProviderPointers: vi.fn().mockResolvedValue({
        transcription: null,
        summary: null,
        learn: null,
        topics: null,
        title: null,
    }),
    setDefaultProvider: vi.fn(),
}));

vi.mock("@/lib/ai/list-providers", () => ({
    listUserProviders: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/encryption", () => ({
    encrypt: vi.fn((value: string) => `encrypted:${value}`),
}));

vi.mock("@/lib/env", () => ({
    env: { IS_HOSTED: false },
}));

vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));

vi.mock("@/lib/profiles/organization-providers", () => ({
    createOrganizationProvider,
    listOrganizationProviders: vi.fn().mockResolvedValue([]),
    organizationAccountProviderAuditContext: vi.fn().mockResolvedValue(null),
    organizationProviderManageContext: vi.fn().mockResolvedValue({
        actor: { kind: "user", actorId: "user-1" },
        userId: "user-1",
        email: "user@example.com",
        orgUserId: "organization-1",
    }),
    organizationProviderReadContext: vi.fn(),
    writeOrganizationProviderAudit: vi.fn(),
}));

import { POST as addOrganizationProvider } from "@/app/api/settings/ai/organization-providers/route";
import { POST as addPersonalProvider } from "@/app/api/settings/ai/providers/route";

const message = "Set a Default Model on Custom in Settings > Providers.";

function request(defaultModel: string | null): Request {
    return new Request("https://example.com/api/settings/ai/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            provider: "Custom",
            apiKey: "test-key",
            defaultModel,
        }),
    });
}

describe.each([
    ["personal", addPersonalProvider],
    ["Organization", addOrganizationProvider],
] as const)("%s provider API", (_scope, addProvider) => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([
        null,
        " \t ",
    ])("returns 400 when Default Model is %j", async (defaultModel) => {
        const response = await addProvider(request(defaultModel));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
            error: message,
            code: "INVALID_INPUT",
            details: { field: "defaultModel" },
        });
        expect(transaction).not.toHaveBeenCalled();
        expect(createOrganizationProvider).not.toHaveBeenCalled();
    });
});
