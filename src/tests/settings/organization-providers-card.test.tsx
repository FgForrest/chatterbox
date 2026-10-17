// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import type {
    ProviderCardItem,
    ProviderScope,
} from "@/components/settings/provider-card";
import { ProviderFormDialog } from "@/components/settings/provider-form-dialog";
import { ProvidersSection } from "@/components/settings-sections/providers-section";

vi.mock("next-intl", () => ({
    useExtracted: () => (text: string, values?: Record<string, unknown>) =>
        Object.entries(values ?? {}).reduce(
            (result, [key, value]) =>
                result.replace(
                    new RegExp(`\\{${key}(?:, number)?\\}`),
                    String(value),
                ),
            text,
        ),
    useLocale: () => "en-US",
}));
vi.mock("sonner", () => ({
    toast: { error: vi.fn(), success: vi.fn() },
}));

const personalProvider: ProviderCardItem = {
    id: "personal-provider",
    provider: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "whisper-large-v3",
    rate: null,
    disabledAt: null,
    isDefaultTranscription: true,
    isDefaultEnhancement: true,
};

const organizationProvider: ProviderCardItem = {
    id: "org-provider",
    provider: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    rate: null,
    disabledAt: null,
    isDefaultTranscription: true,
    isDefaultEnhancement: true,
    isDefaultLearn: true,
    isDefaultTopics: true,
    isDefaultTitle: true,
};

const titles: Record<ProviderScope, string> = {
    personal: "Your providers",
    organization: "Organization providers",
};

const descriptions: Record<ProviderScope, string> = {
    personal: "Only you can use these keys.",
    organization:
        "Shared with every member. Organization defaults apply until a member chooses another provider. Keys are write-only.",
};

const collections: Record<ProviderScope, string> = {
    personal: "/api/settings/ai/providers",
    organization: "/api/settings/ai/organization-providers",
};

interface RequestRecord {
    url: string;
    method: string;
    body: Record<string, unknown> | null;
}

let personal: ProviderCardItem[];
let organization: ProviderCardItem[];
let manager: boolean;
let requests: RequestRecord[];

function providerFor(scope: ProviderScope): ProviderCardItem {
    return scope === "personal" ? personalProvider : organizationProvider;
}

function recordRequest(url: string, init?: RequestInit): RequestRecord {
    const body = init?.body ? (JSON.parse(String(init.body)) as object) : null;
    const record = {
        url,
        method: init?.method ?? "GET",
        body: body as Record<string, unknown> | null,
    };
    requests.push(record);
    return record;
}

function installFetch() {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method ?? "GET";
            if (
                url === "/api/settings/ai/providers?includeDisabled=true" &&
                method === "GET"
            ) {
                return Response.json({ providers: personal });
            }
            if (
                url === "/api/settings/ai/organization-providers" &&
                method === "GET"
            ) {
                return Response.json({
                    providers: organization.map((provider) => ({
                        ...provider,
                        apiKey: "never-render-this-secret",
                    })),
                });
            }
            if (url === "/api/settings/ai/organization-providers/usage") {
                if (!manager) {
                    return Response.json(
                        { error: "Capability required" },
                        { status: 403 },
                    );
                }
                return Response.json({
                    members: [
                        {
                            userId: "member-1",
                            email: "member@example.test",
                            calls: 12,
                            estimatedCostUsd: "1.250000000",
                        },
                    ],
                });
            }
            if (
                url ===
                    "/api/settings/ai/organization-providers/org-provider" &&
                method === "GET"
            ) {
                return Response.json({ memberDefaultCount: 2 });
            }
            const request = recordRequest(url, init);
            if (method === "PUT" && request.body?.disabled !== undefined) {
                const target = url.includes("organization-providers")
                    ? organization
                    : personal;
                const id = decodeURIComponent(url.split("/").at(-1) ?? "");
                const disabled = request.body.disabled === true;
                const index = target.findIndex(
                    (provider) => provider.id === id,
                );
                if (index >= 0) {
                    target[index] = {
                        ...target[index],
                        disabledAt: disabled ? new Date().toISOString() : null,
                    };
                }
            }
            return Response.json({ success: true, provider: { id: "new" } });
        }),
    );
}

function renderSection() {
    return render(
        <ConfirmDialogProvider>
            <ProvidersSection initialProviders={personal} />
        </ConfirmDialogProvider>,
    );
}

async function cardFor(scope: ProviderScope) {
    return screen.findByRole("region", { name: titles[scope] });
}

async function confirmAction(label: string) {
    fireEvent.click(await screen.findByRole("button", { name: label }));
}

beforeEach(() => {
    personal = [{ ...personalProvider }];
    organization = [{ ...organizationProvider }];
    manager = true;
    requests = [];
    installFetch();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe.each([
    "personal",
    "organization",
] as const)("%s provider card", (scope) => {
    it("shows the scoped header, icon, description, and one Add button", async () => {
        renderSection();
        const card = await cardFor(scope);
        expect(within(card).getByText(titles[scope])).toBeTruthy();
        expect(within(card).getByText(descriptions[scope])).toBeTruthy();
        expect(within(card).getByTestId(`${scope}-provider-icon`)).toBeTruthy();
        expect(
            within(card).getAllByRole("button", { name: /Add .*provider/i }),
        ).toHaveLength(1);
    });

    it("shows a compact empty state without a second Add button", async () => {
        if (scope === "personal") personal = [];
        else organization = [];
        renderSection();
        const card = await cardFor(scope);
        const expected =
            scope === "personal"
                ? "No providers yet. Add one to transcribe and summarize."
                : "No Organization providers yet.";
        expect(within(card).getByText(expected)).toBeTruthy();
        expect(
            within(card).getAllByRole("button", { name: /Add .*provider/i }),
        ).toHaveLength(1);
    });

    it("opens the duplicate form and posts a copy to the scoped route", async () => {
        renderSection();
        const provider = providerFor(scope);
        const card = await cardFor(scope);
        fireEvent.click(
            within(card).getByRole("button", {
                name: `Duplicate ${provider.provider} · ${provider.defaultModel}`,
            }),
        );
        expect(
            await screen.findByRole("heading", {
                name: "Duplicate AI Provider",
            }),
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Add Copy" }));
        await waitFor(() => {
            expect(requests).toContainEqual(
                expect.objectContaining({
                    url: collections[scope],
                    method: "POST",
                    body: expect.objectContaining({
                        copyKeyFrom: provider.id,
                        provider: provider.provider,
                    }),
                }),
            );
        });
    });

    it("opens the edit form and puts changes to the scoped route", async () => {
        renderSection();
        const provider = providerFor(scope);
        const card = await cardFor(scope);
        fireEvent.click(
            within(card).getByRole("button", {
                name: `Edit ${provider.provider} · ${provider.defaultModel}`,
            }),
        );
        expect(
            await screen.findByRole("heading", {
                name: "Edit AI Provider",
            }),
        ).toBeTruthy();
        fireEvent.click(
            screen.getByRole("button", { name: "Update Provider" }),
        );
        await waitFor(() => {
            expect(requests).toContainEqual(
                expect.objectContaining({
                    url: `${collections[scope]}/${provider.id}`,
                    method: "PUT",
                }),
            );
        });
        const update = requests.find(
            (request) =>
                request.url === `${collections[scope]}/${provider.id}` &&
                request.method === "PUT",
        );
        expect(update?.body).not.toHaveProperty("isDefaultTranscription");
        expect(update?.body).not.toHaveProperty("isDefaultEnhancement");
    });

    it("confirms disabling and enables immediately", async () => {
        renderSection();
        const provider = providerFor(scope);
        let card = await cardFor(scope);
        fireEvent.click(
            within(card).getByRole("button", {
                name: `Disable ${provider.provider} · ${provider.defaultModel}`,
            }),
        );
        const confirmation =
            scope === "personal"
                ? "Transcription and Summaries use this provider. They stop with an error until you enable it again or choose another provider."
                : "This provider is the Organization default for Transcription, Summaries, Learn, Topics, and Titles. Members following those defaults will stop until it is enabled or another default is chosen. Members who chose it as their own default: 2. Their runs will also stop until they choose another provider.";
        expect(await screen.findByText(confirmation)).toBeTruthy();
        await confirmAction("Disable");
        await waitFor(() => {
            expect(requests).toContainEqual({
                url: `${collections[scope]}/${provider.id}`,
                method: "PUT",
                body: { disabled: true },
            });
        });
        card = await cardFor(scope);
        expect(within(card).getByText("Disabled")).toBeTruthy();
        if (scope === "organization") {
            expect(
                within(card).getByText("Disabled Organization default"),
            ).toBeTruthy();
        }
        fireEvent.click(
            within(card).getByRole("button", {
                name: `Enable ${provider.provider} · ${provider.defaultModel}`,
            }),
        );
        await waitFor(() => {
            expect(requests).toContainEqual({
                url: `${collections[scope]}/${provider.id}`,
                method: "PUT",
                body: { disabled: false },
            });
        });
    });

    it("confirms deletion and sends it to the scoped route", async () => {
        renderSection();
        const provider = providerFor(scope);
        const card = await cardFor(scope);
        fireEvent.click(
            within(card).getByRole("button", {
                name: `Delete ${provider.provider} · ${provider.defaultModel}`,
            }),
        );
        if (scope === "organization") {
            expect(
                await screen.findByText(
                    "Profiles that pin it will stop with an error until another provider is selected. Members who chose it as their own default: 2. Their runs will stop until they choose another provider.",
                ),
            ).toBeTruthy();
        }
        await confirmAction("Delete");
        await waitFor(() => {
            expect(requests).toContainEqual({
                url: `${collections[scope]}/${provider.id}`,
                method: "DELETE",
                body: null,
            });
        });
    });

    it("shows Disabled and gives a managed row no actions", async () => {
        const disabled = {
            ...providerFor(scope),
            disabledAt: new Date().toISOString(),
        };
        const managed = {
            ...providerFor(scope),
            id: `${scope}-managed`,
            provider: "Mynah",
            defaultModel: null,
            managed: true,
        };
        if (scope === "personal") personal = [disabled, managed];
        else organization = [disabled, managed];
        renderSection();
        const card = await cardFor(scope);
        expect(within(card).getByText("Disabled")).toBeTruthy();
        expect(
            within(card).queryByRole("button", {
                name: /Duplicate Mynah/,
            }),
        ).toBeNull();
        expect(
            within(card).queryByRole("button", { name: /Edit Mynah/ }),
        ).toBeNull();
        expect(
            within(card).queryByRole("button", { name: /Delete Mynah/ }),
        ).toBeNull();
    });

    it.each([
        "add",
        "edit",
        "duplicate",
    ] as const)("renders the shared form in %s mode", (mode) => {
        const source = mode === "add" ? null : providerFor(scope);
        let expected = "Duplicate AI Provider";
        if (mode === "add") expected = "Add AI Provider";
        else if (mode === "edit") expected = "Edit AI Provider";
        render(
            <ProviderFormDialog
                scope={scope}
                mode={mode}
                provider={source}
                open
                isHosted={false}
                onOpenChange={vi.fn()}
                onSuccess={vi.fn()}
            />,
        );
        expect(screen.getByRole("heading", { name: expected })).toBeTruthy();
        if (scope === "personal") {
            expect(screen.getByText("Use for transcription")).toBeTruthy();
            expect(screen.getByText("Use for summaries")).toBeTruthy();
        } else {
            expect(
                screen.getByText("Organization default for transcription"),
            ).toBeTruthy();
            expect(
                screen.getByText("Organization default for summaries"),
            ).toBeTruthy();
            expect(
                screen.getByText("Organization default for Learn"),
            ).toBeTruthy();
            expect(
                screen.getByText("Organization default for topics"),
            ).toBeTruthy();
            expect(
                screen.getByText("Organization default for titles"),
            ).toBeTruthy();
        }
    });
});

describe("Organization provider permissions and usage", () => {
    it("shows a read-only card without actions or Add", async () => {
        manager = false;
        renderSection();
        const card = await cardFor("organization");
        expect(await within(card).findByText("Read-only")).toBeTruthy();
        expect(within(card).queryByRole("button")).toBeNull();
        expect(within(card).getByText("OpenAI")).toBeTruthy();
        expect(within(card).getByText("Transcription")).toBeTruthy();
        expect(within(card).getByText("Summaries")).toBeTruthy();
        expect(within(card).getByText("Learn")).toBeTruthy();
        expect(within(card).getByText("Topics")).toBeTruthy();
        expect(within(card).getByText("Titles")).toBeTruthy();
        expect(within(card).queryByText("never-render-this-secret")).toBeNull();
    });

    it("keeps usage per member inside the Organization card", async () => {
        renderSection();
        const card = await cardFor("organization");
        expect(
            await within(card).findByText("member@example.test"),
        ).toBeTruthy();
        expect(within(card).getByText("12")).toBeTruthy();
        expect(within(card).getByText("$1.25")).toBeTruthy();
    });
});
