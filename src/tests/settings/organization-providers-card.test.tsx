// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { ProvidersSection } from "@/components/settings-sections/providers-section";

vi.mock("next-intl", () => ({
    useExtracted: () => (text: string, values?: Record<string, unknown>) =>
        Object.entries(values ?? {}).reduce(
            (result, [key, value]) => result.replace(`{${key}}`, String(value)),
            text,
        ),
    useLocale: () => "en-US",
}));
vi.mock("sonner", () => ({
    toast: { error: vi.fn(), success: vi.fn() },
}));

const organizationProvider = {
    id: "org-provider",
    provider: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    rate: null,
    disabledAt: null,
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
    scope: "organization",
};

function renderSection() {
    return render(
        <ConfirmDialogProvider>
            <ProvidersSection
                initialProviders={[
                    {
                        id: "personal-provider",
                        provider: "Groq",
                        baseUrl: null,
                        defaultModel: "whisper-large-v3",
                        isDefaultTranscription: true,
                        isDefaultEnhancement: false,
                        createdAt: new Date(0),
                    },
                ]}
            />
        </ConfirmDialogProvider>,
    );
}

describe("Organization providers card", () => {
    let manager: boolean;

    beforeEach(() => {
        manager = true;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: string | URL | Request) => {
                const url = String(input);
                if (url === "/api/settings/ai/organization-providers") {
                    return Response.json({
                        providers: [
                            {
                                ...organizationProvider,
                                apiKey: "never-render-this-secret",
                            },
                        ],
                    });
                }
                if (url === "/api/settings/ai/organization-providers/usage") {
                    return manager
                        ? Response.json({
                              members: [
                                  {
                                      userId: "member-1",
                                      email: "member@example.test",
                                      calls: 12,
                                      estimatedCostUsd: "1.250000000",
                                  },
                              ],
                          })
                        : Response.json(
                              { error: "Capability required" },
                              { status: 403 },
                          );
                }
                return Response.json({});
            }),
        );
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("shows management actions and member usage to a manager without rendering keys", async () => {
        renderSection();
        await screen.findByText("Organization providers");
        expect(
            screen.getByRole("button", { name: "Add organization provider" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Edit OpenAI · gpt-4o-mini" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", {
                name: "Disable OpenAI · gpt-4o-mini",
            }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Delete OpenAI · gpt-4o-mini" }),
        ).toBeTruthy();
        expect(await screen.findByText("member@example.test")).toBeTruthy();
        expect(screen.getByText("12")).toBeTruthy();
        expect(screen.getByText("$1.25")).toBeTruthy();
        expect(screen.queryByText("never-render-this-secret")).toBeNull();
    });

    it("shows members a read-only list", async () => {
        manager = false;
        renderSection();
        await screen.findByText("Organization providers");
        await waitFor(() => expect(screen.getByText("Read-only")).toBeTruthy());
        expect(
            screen.queryByRole("button", { name: "Add organization provider" }),
        ).toBeNull();
        expect(
            screen.queryByRole("button", { name: /Edit OpenAI/ }),
        ).toBeNull();
        expect(
            screen.queryByRole("button", { name: /Disable OpenAI/ }),
        ).toBeNull();
        expect(
            screen.queryByRole("button", { name: /Delete OpenAI/ }),
        ).toBeNull();
        expect(screen.getByText("OpenAI")).toBeTruthy();
        expect(screen.queryByText("never-render-this-secret")).toBeNull();
    });
});
