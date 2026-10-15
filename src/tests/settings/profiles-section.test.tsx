// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfilesSection } from "@/components/settings-sections/profiles-section";
import { defaultProfileSettings } from "@/lib/profiles/settings";

const { toastError, translate } = vi.hoisted(() => ({
    toastError: vi.fn(),
    translate: (text: string, values?: Record<string, unknown>) =>
        Object.entries(values ?? {}).reduce(
            (result, [key, value]) => result.replace(`{${key}}`, String(value)),
            text,
        ),
}));

vi.mock("next-intl", () => ({
    useExtracted: () => translate,
    useLocale: () => "en",
}));
vi.mock("sonner", () => ({
    toast: { error: toastError, success: vi.fn() },
}));

type FetchCall = { url: string; method: string; body: unknown };

const audioSettings = defaultProfileSettings("audio");
audioSettings.steps.summary.outputFormat = {
    en: "English custom",
    "cs-CZ": "Český vlastní formát",
};

const profiles = [
    {
        id: "personal-default",
        name: "Default Profile",
        description: null,
        channel: "audio" as const,
        scope: "personal" as const,
        isDefault: true,
        version: 2,
        canEdit: true,
        archivedAt: null,
        updatedAt: "2026-10-15T00:00:00.000Z",
    },
    {
        id: "org-readonly",
        name: "Org Profile",
        description: null,
        channel: "audio" as const,
        scope: "organization" as const,
        isDefault: false,
        version: 1,
        canEdit: false,
        archivedAt: null,
        updatedAt: "2026-10-15T00:00:00.000Z",
    },
    {
        id: "mail-profile",
        name: "Mail Profile",
        description: null,
        channel: "mail" as const,
        scope: "personal" as const,
        isDefault: false,
        version: 1,
        canEdit: true,
        archivedAt: null,
        updatedAt: "2026-10-15T00:00:00.000Z",
    },
];

const builtins = {
    builtinPromptsVersion: "test",
    builtins: {
        focus: { en: "Built-in focus", "cs-CZ": "Výchozí zaměření" },
        outputFormat: {
            en: "Built-in English format",
            "cs-CZ": "Výchozí český formát",
        },
    },
};

function detail(id: string) {
    const summary = profiles.find((profile) => profile.id === id);
    if (!summary) throw new Error(`Missing fixture ${id}`);
    return {
        profile: {
            ...summary,
            settings:
                summary.channel === "mail"
                    ? defaultProfileSettings("mail")
                    : structuredClone(audioSettings),
        },
        ...builtins,
    };
}

describe("Settings Profiles", () => {
    let calls: FetchCall[];
    let conflict = false;

    beforeEach(() => {
        calls = [];
        conflict = false;
        toastError.mockClear();
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";
                const body = init?.body ? JSON.parse(String(init.body)) : null;
                calls.push({ url, method, body });

                if (url === "/api/settings/ai/providers") {
                    return Response.json({
                        providers: [
                            {
                                id: "personal-ai",
                                provider: "OpenAI",
                                defaultModel: "gpt-test",
                                baseUrl: null,
                                isDefaultTranscription: false,
                                isDefaultEnhancement: true,
                                createdAt: "2026-10-15T00:00:00.000Z",
                            },
                        ],
                    });
                }
                if (url === "/api/settings/ai/organization-providers/") {
                    return new Response(null, { status: 404 });
                }
                if (url === "/api/settings/ai/organization-providers") {
                    return Response.json({
                        providers: [
                            {
                                id: "org-ai",
                                provider: "Anthropic",
                                defaultModel: "claude-test",
                                disabledAt: null,
                                scope: "organization",
                            },
                        ],
                    });
                }
                const detailMatch = url.match(
                    /^\/api\/settings\/profiles\/([^/?]+)$/,
                );
                if (detailMatch && method === "GET") {
                    const id = detailMatch[1] as string;
                    if (conflict && id === "personal-default") {
                        const latest = detail(id);
                        latest.profile.version = 3;
                        latest.profile.settings.steps.summary.focus =
                            "Server focus";
                        return Response.json(latest);
                    }
                    return Response.json(detail(id));
                }
                if (detailMatch && method === "PUT" && conflict) {
                    return Response.json(
                        { error: "Profile version conflict" },
                        { status: 409 },
                    );
                }
                if (detailMatch && method === "PUT") {
                    return Response.json({
                        profile: {
                            ...detail(detailMatch[1] as string).profile,
                            version: 3,
                        },
                    });
                }
                if (url.startsWith("/api/settings/profiles?")) {
                    return Response.json({
                        profiles,
                        pagination: {
                            page: 1,
                            pageSize: 10,
                            total: profiles.length,
                            totalPages: 1,
                        },
                    });
                }
                return Response.json({ success: true });
            }),
        );
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    async function renderList() {
        render(<ProfilesSection />);
        await screen.findByText("Default Profile");
    }

    async function edit(name: string) {
        await renderList();
        fireEvent.click(screen.getByRole("button", { name: `Edit ${name}` }));
        await screen.findByRole("dialog", { name: `Edit ${name}` });
    }

    it("sends search and list filters to the server and enforces row permissions", async () => {
        await renderList();

        fireEvent.change(
            screen.getByRole("searchbox", { name: "Search profiles" }),
            {
                target: { value: "meeting" },
            },
        );
        fireEvent.change(screen.getByRole("combobox", { name: "Channel" }), {
            target: { value: "mail" },
        });
        fireEvent.change(screen.getByRole("combobox", { name: "Scope" }), {
            target: { value: "organization" },
        });

        await waitFor(() =>
            expect(
                calls.some(
                    (call) =>
                        call.url ===
                        "/api/settings/profiles?q=meeting&channel=mail&scope=organization&page=1&pageSize=10",
                ),
            ).toBe(true),
        );
        expect(
            screen.queryByRole("button", { name: "Edit Org Profile" }),
        ).toBeNull();
        expect(
            screen.getByRole("button", {
                name: "Duplicate to personal Org Profile",
            }),
        ).toBeTruthy();
        expect(
            screen.queryByRole("button", { name: "Archive Default Profile" }),
        ).toBeNull();
    });

    it("keeps localized output-format edits isolated and restores one locale only", async () => {
        await edit("Default Profile");
        fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
        fireEvent.click(
            screen.getByRole("tab", { name: "Czech output format" }),
        );
        const format = screen.getByRole("textbox", { name: "Output format" });
        fireEvent.change(format, { target: { value: "Nový český formát" } });
        fireEvent.click(
            screen.getByRole("button", {
                name: "Restore default Output format",
            }),
        );
        expect(
            (
                screen.getByRole("textbox", {
                    name: "Output format",
                }) as HTMLTextAreaElement
            ).value,
        ).toBe("Výchozí český formát");

        fireEvent.click(
            screen.getByRole("tab", { name: "English output format" }),
        );
        expect(
            (
                screen.getByRole("textbox", {
                    name: "Output format",
                }) as HTMLTextAreaElement
            ).value,
        ).toBe("English custom");

        fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
        await waitFor(() =>
            expect(
                calls.some(
                    (call) =>
                        call.method === "PUT" &&
                        (call.body as { expectedVersion: number })
                            .expectedVersion === 2 &&
                        (call.body as { settings: typeof audioSettings })
                            .settings.steps.summary.outputFormat["cs-CZ"] ===
                            undefined &&
                        (call.body as { settings: typeof audioSettings })
                            .settings.steps.summary.outputFormat.en ===
                            "English custom",
                ),
            ).toBe(true),
        );
    });

    it("disables summary focus and formats when a full prompt is set", async () => {
        await edit("Default Profile");
        fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Full prompt" }), {
            target: { value: "Use only this prompt" },
        });

        expect(
            (
                screen.getByRole("textbox", {
                    name: "Summary focus",
                }) as HTMLInputElement
            ).disabled,
        ).toBe(true);
        expect(
            (
                screen.getByRole("textbox", {
                    name: "Output format",
                }) as HTMLTextAreaElement
            ).disabled,
        ).toBe(true);
        expect(
            screen.getByText(
                "A full prompt replaces the summary focus and output format.",
            ),
        ).toBeTruthy();
    });

    it("does not show recording-only steps in a mail profile", async () => {
        await edit("Mail Profile");
        fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));

        expect(
            screen.queryByRole("heading", { name: "Transcribe" }),
        ).toBeNull();
        expect(screen.queryByRole("heading", { name: "Topics" })).toBeNull();
        expect(screen.getByRole("heading", { name: "Learn" })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Title" })).toBeTruthy();
    });

    it("reloads after a version conflict and keeps the unsaved text available", async () => {
        conflict = true;
        await edit("Default Profile");
        fireEvent.change(
            screen.getByRole("textbox", { name: "Summary focus" }),
            {
                target: { value: "My unsaved focus" },
            },
        );
        fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

        expect(
            (
                await screen.findByRole("textbox", {
                    name: "Unsaved profile changes",
                })
            ).getAttribute("value") ??
                (
                    screen.getByRole("textbox", {
                        name: "Unsaved profile changes",
                    }) as HTMLTextAreaElement
                ).value,
        ).toContain("My unsaved focus");
        expect(
            (
                screen.getByRole("textbox", {
                    name: "Summary focus",
                }) as HTMLInputElement
            ).value,
        ).toBe("Server focus");
        expect(toastError).toHaveBeenCalled();
    });
});
