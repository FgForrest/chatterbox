// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderRoleSelect } from "@/components/settings/provider-role-select";

vi.mock("next-intl", () => ({
    useExtracted: () => (message: string, values?: Record<string, string>) =>
        values ? message.replace("{provider}", values.provider ?? "") : message,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/components/ui/select", () => ({
    Select: ({ children }: { children: React.ReactNode }) => (
        <div>{children}</div>
    ),
    SelectContent: ({ children }: { children: React.ReactNode }) => (
        <div>{children}</div>
    ),
    SelectGroup: ({ children }: { children: React.ReactNode }) => (
        <section>{children}</section>
    ),
    SelectItem: ({ children }: { children: React.ReactNode }) => (
        <div>{children}</div>
    ),
    SelectLabel: ({ children }: { children: React.ReactNode }) => (
        <h3>{children}</h3>
    ),
    SelectTrigger: ({ children }: { children: React.ReactNode }) => (
        <div>{children}</div>
    ),
    SelectValue: ({ placeholder }: { placeholder?: React.ReactNode }) => (
        <span>{placeholder}</span>
    ),
}));

const provider = (id: string, name: string, organizationDefault = false) => ({
    id,
    provider: name,
    baseUrl: null,
    defaultModel: "model",
    isDefaultTranscription: organizationDefault,
    isDefaultEnhancement: organizationDefault,
    isDefaultLearn: organizationDefault,
    isDefaultTopics: organizationDefault,
    isDefaultTitle: organizationDefault,
    createdAt: new Date(),
});

describe.each([
    "transcription",
    "summary",
    "topics",
    "learning",
    "title",
] as const)("%s provider picker", (purpose) => {
    beforeEach(() => {
        vi.stubGlobal(
            "fetch",
            vi.fn((url: string) => {
                const body = url.includes("organization-providers")
                    ? { providers: [provider("org", "Organization AI", true)] }
                    : {
                          providers: [provider("personal", "Personal AI")],
                          defaults: {
                              transcription: null,
                              summary: null,
                              learn: null,
                              topics: null,
                              title: null,
                          },
                      };
                return Promise.resolve(
                    new Response(JSON.stringify(body), { status: 200 }),
                );
            }),
        );
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("groups personal and Organization choices and names the Organization default", async () => {
        render(<ProviderRoleSelect purpose={purpose} />);
        await waitFor(() => {
            expect(screen.getByText("Your providers")).toBeTruthy();
        });
        expect(screen.getByText("Organization providers")).toBeTruthy();
        expect(
            screen.getByText("Organization default: Organization AI · model"),
        ).toBeTruthy();
    });
});

describe("empty provider picker", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("links the empty state to Providers", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(() =>
                Promise.resolve(
                    new Response(JSON.stringify({ providers: [] }), {
                        status: 200,
                    }),
                ),
            ),
        );
        render(<ProviderRoleSelect purpose="summary" />);
        await waitFor(() => {
            expect(
                screen.getByRole("link", { name: "Open Providers" }),
            ).toBeTruthy();
        });
        expect(
            screen.getAllByText(
                "None of your providers or the Organization's can do this yet.",
            ).length,
        ).toBeGreaterThan(0);
    });

    it("names the automatic own chat fallback in the unset option", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn((url: string) => {
                const body = url.includes("organization-providers")
                    ? { providers: [] }
                    : {
                          providers: [provider("personal", "Personal AI")],
                          defaults: {
                              transcription: null,
                              summary: null,
                              learn: null,
                              topics: null,
                              title: null,
                          },
                      };
                return Promise.resolve(Response.json(body));
            }),
        );
        render(<ProviderRoleSelect purpose="summary" />);

        expect(
            await screen.findByText("Automatic: Personal AI · model"),
        ).toBeTruthy();
    });
});
