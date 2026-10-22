import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    lookup,
    transaction,
    createOrganizationProvider,
    updateOrganizationProvider,
    providerFetch,
} = vi.hoisted(() => ({
    lookup: vi.fn(),
    transaction: vi.fn(),
    createOrganizationProvider: vi.fn(),
    updateOrganizationProvider: vi.fn(),
    providerFetch: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: true } }));
vi.mock("@/db", () => ({
    db: {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [
                        {
                            id: "provider",
                            provider: "Custom",
                            defaultModel: "example",
                            disabledAt: null,
                        },
                    ],
                }),
            }),
        }),
        transaction,
    },
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({
        user: { id: "user", email: "user@example.com" },
    }),
    requireApiSessionActor: async () => ({
        session: { user: { id: "user", email: "user@example.com" } },
        actor: { kind: "user", actorId: "user" },
    }),
}));
vi.mock("@/lib/ai/default-provider", () => ({
    loadDefaultProviderPointers: vi.fn(),
    setDefaultProvider: vi.fn(),
}));
vi.mock("@/lib/ai/set-default-transcription", () => ({
    setDefaultTranscriptionProvider: vi.fn(),
}));
vi.mock("@/lib/ai/list-providers", () => ({ listUserProviders: vi.fn() }));
vi.mock("@/lib/ai/provider-fetch", () => ({ providerFetch }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/pipeline/provider-recovery", () => ({
    requestProviderRecoveryInTx: vi.fn(),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/encryption", () => ({
    encrypt: (value: string) => `encrypted:${value}`,
}));
vi.mock("@/lib/profiles/organization-providers", () => ({
    createOrganizationProvider,
    updateOrganizationProvider,
    organizationAccountProviderAuditContext: async () => null,
    organizationProviderManageContext: async () => ({
        orgUserId: "organization",
    }),
    organizationProviderReadContext: vi.fn(),
    listOrganizationProviders: vi.fn(),
    writeOrganizationProviderAudit: vi.fn(),
    deleteOrganizationProvider: vi.fn(),
    organizationProviderMemberDefaultCount: vi.fn(),
}));

import { PUT as updateOrganization } from "@/app/api/settings/ai/organization-providers/[id]/route";
import { POST as createOrganization } from "@/app/api/settings/ai/organization-providers/route";
import { PUT as updatePersonal } from "@/app/api/settings/ai/providers/[id]/route";
import { POST as models } from "@/app/api/settings/ai/providers/models/route";
import { POST as createPersonal } from "@/app/api/settings/ai/providers/route";
import { HOSTED_LOCAL_BASE_URL_MESSAGE } from "@/lib/ai/validate-base-url";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";

const context = { params: Promise.resolve({ id: "provider" }) };
function request(baseUrl: string, route: string) {
    return new Request("https://app.example.com/api/settings/ai/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            ...(route === "Organization update"
                ? {}
                : {
                      provider:
                          route === "models probe" ? "OpenRouter" : "Custom",
                  }),
            apiKey: "test-key",
            defaultModel: "example",
            baseUrl,
        }),
    });
}

describe.each([
    ["personal create", createPersonal],
    ["personal update", updatePersonal],
    ["Organization create", createOrganization],
    ["Organization update", updateOrganization],
    ["models probe", models],
] as const)("%s public-target validation", (_name, handler) => {
    beforeEach(() => {
        vi.clearAllMocks();
        env.IS_HOSTED = true;
        lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
        transaction.mockResolvedValue({ id: "provider" });
        createOrganizationProvider.mockResolvedValue({ id: "provider" });
        updateOrganizationProvider.mockResolvedValue(undefined);
        providerFetch.mockResolvedValue(Response.json({ data: [] }));
    });

    it.each([
        "http://10.0.0.1/v1",
        "http://172.20.0.1/v1",
        "http://192.168.1.10/v1",
        "http://169.254.169.254/v1",
        "http://[fd00:ec2::254]/v1",
        "http://[fe80::1]/v1",
        "http://[::ffff:10.0.0.1]/v1",
        "https://service.internal/v1",
    ])("rejects %s before writes or HTTP", async (url) => {
        const response = await handler(request(url, _name), context);
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            code: "INVALID_INPUT",
            details: { field: "baseUrl" },
        });
        expect(transaction).not.toHaveBeenCalled();
        expect(createOrganizationProvider).not.toHaveBeenCalled();
        expect(updateOrganizationProvider).not.toHaveBeenCalled();
        expect(providerFetch).not.toHaveBeenCalled();
    });

    it("rejects a private answer in a mixed DNS response", async () => {
        lookup.mockResolvedValue([
            { address: "8.8.8.8", family: 4 },
            { address: "10.0.0.1", family: 4 },
        ]);
        expect(
            (
                await handler(
                    request("https://api.example.com/v1", _name),
                    context,
                )
            ).status,
        ).toBe(400);
        expect(transaction).not.toHaveBeenCalled();
        expect(createOrganizationProvider).not.toHaveBeenCalled();
        expect(updateOrganizationProvider).not.toHaveBeenCalled();
        expect(providerFetch).not.toHaveBeenCalled();
    });

    it("accepts a public target", async () => {
        expect(
            (
                await handler(
                    request("https://api.example.com/v1", _name),
                    context,
                )
            ).status,
        ).toBe(200);
        expect(lookup).toHaveBeenCalledWith("api.example.com", {
            all: true,
            verbatim: true,
        });
    });

    it("self-host accepts LAN targets without resolving", async () => {
        env.IS_HOSTED = false;
        expect(
            (await handler(request("http://ollama:11434/v1", _name), context))
                .status,
        ).toBe(200);
        expect(lookup).not.toHaveBeenCalled();
    });
});

it("keeps a request-time policy refusal readable in the models probe", async () => {
    env.IS_HOSTED = true;
    lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    providerFetch.mockRejectedValueOnce(
        new AppError(
            ErrorCode.INVALID_INPUT,
            HOSTED_LOCAL_BASE_URL_MESSAGE,
            400,
            { field: "baseUrl" },
        ),
    );
    const response = await models(
        request("https://api.example.com/v1", "models probe"),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
        error: HOSTED_LOCAL_BASE_URL_MESSAGE,
        code: "INVALID_INPUT",
        details: { field: "baseUrl" },
    });
});
