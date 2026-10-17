// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { ProfilesSection } from "@/components/settings-sections/profiles-section";
import {
    type AudioProfileSettings,
    defaultProfileSettings,
} from "@/lib/profiles/settings";

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
        isYourDefault: false,
        isOrganizationDefault: false,
        deleteDisposition: "archive" as const,
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
        isYourDefault: true,
        isOrganizationDefault: true,
        deleteDisposition: null,
        version: 1,
        canEdit: false,
        archivedAt: null,
        updatedAt: "2026-10-15T00:00:00.000Z",
    },
    {
        id: "unavailable-pin",
        name: "Unavailable Pin",
        description: null,
        channel: "audio" as const,
        scope: "personal" as const,
        isDefault: false,
        isYourDefault: false,
        isOrganizationDefault: false,
        deleteDisposition: "delete" as const,
        version: 1,
        canEdit: true,
        archivedAt: null,
        updatedAt: "2026-10-15T00:00:00.000Z",
    },
    {
        id: "last-personal",
        name: "Last Personal Profile",
        description: null,
        channel: "audio" as const,
        scope: "personal" as const,
        isDefault: false,
        isYourDefault: false,
        isOrganizationDefault: false,
        deleteDisposition: "archive" as const,
        version: 1,
        canEdit: true,
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
        isYourDefault: true,
        isOrganizationDefault: false,
        deleteDisposition: "delete" as const,
        version: 1,
        canEdit: true,
        archivedAt: null,
        updatedAt: "2026-10-15T00:00:00.000Z",
    },
];

const archivedProfile = {
    id: "archived-profile",
    name: "Archived Profile",
    description: null,
    channel: "audio" as const,
    scope: "personal" as const,
    isDefault: false,
    version: 2,
    canEdit: true,
    archivedAt: "2026-10-15T01:00:00.000Z",
    updatedAt: "2026-10-15T01:00:00.000Z",
};

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
    const settings =
        summary.channel === "mail"
            ? defaultProfileSettings("mail")
            : structuredClone(audioSettings);
    if (id === "unavailable-pin" && "transcribe" in settings.steps) {
        (settings as AudioProfileSettings).steps.transcribe.provider = {
            credentialId: "deleted-provider",
            scope: "personal",
        };
    }
    return {
        profile: {
            ...summary,
            settings,
        },
        ...builtins,
    };
}

describe("Settings Profiles", () => {
    let calls: FetchCall[];
    let conflict = false;
    let canCreateOrganization = false;
    let badRequest = false;

    beforeEach(() => {
        calls = [];
        conflict = false;
        canCreateOrganization = false;
        badRequest = false;
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
                            {
                                id: "transcription-ai",
                                provider: "ElevenLabs",
                                defaultModel: "scribe_v2",
                                baseUrl: null,
                                isDefaultTranscription: true,
                                isDefaultEnhancement: false,
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
                const deleteImpactMatch = url.match(
                    /^\/api\/settings\/profiles\/([^/?]+)\?deleteImpact=true$/,
                );
                if (deleteImpactMatch && method === "GET") {
                    const summary = profiles.find(
                        (profile) => profile.id === deleteImpactMatch[1],
                    );
                    return Response.json({
                        deleteImpact: {
                            disposition:
                                summary?.scope === "personal"
                                    ? summary.deleteDisposition
                                    : null,
                            memberDefaultCount: 0,
                        },
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
                if (detailMatch && method === "PUT" && badRequest) {
                    return Response.json(
                        { error: "Choose another provider." },
                        { status: 400 },
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
                    const listedProfiles = url.includes("archived=true")
                        ? [archivedProfile]
                        : profiles;
                    return Response.json({
                        profiles: listedProfiles,
                        defaults: {
                            audio: {
                                selected: "organization_default",
                                organizationDefault: {
                                    id: "org-readonly",
                                    name: "Org Profile",
                                },
                                explicitUnavailable: false,
                            },
                            mail: {
                                selected: "mail-profile",
                                organizationDefault: null,
                                explicitUnavailable: false,
                            },
                            options: profiles.map((profile) => ({
                                id: profile.id,
                                name: profile.name,
                                channel: profile.channel,
                                scope: profile.scope,
                            })),
                        },
                        permissions: { canCreateOrganization },
                        pagination: {
                            page: 1,
                            pageSize: 10,
                            total: listedProfiles.length,
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
        render(
            <ConfirmDialogProvider>
                <ProfilesSection />
            </ConfirmDialogProvider>,
        );
        await screen.findByRole("button", { name: "Edit Default Profile" });
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
            screen.getByRole("button", { name: "Delete Default Profile" }),
        ).toBeTruthy();
    });

    it("shows both channel defaults and distinguishes member and Organization badges", async () => {
        await renderList();

        const recordings = screen.getByRole("combobox", {
            name: "Default for recordings",
        });
        const mail = screen.getByRole("combobox", {
            name: "Default for mail",
        });
        expect(recordings.textContent).toContain(
            "Organization default (Org Profile)",
        );
        expect(
            screen.getByRole("option", { name: "Default Profile" }),
        ).toBeTruthy();
        expect(mail.textContent).toContain("Mail Profile");
        expect(screen.getAllByText("Your default")).toHaveLength(2);
        expect(screen.getByText("Organization default")).toBeTruthy();

        fireEvent.change(recordings, { target: { value: "org-readonly" } });
        await waitFor(() =>
            expect(
                calls.some(
                    (call) =>
                        call.url === "/api/settings/profiles/defaults" &&
                        call.method === "POST" &&
                        (call.body as { channel: string }).channel ===
                            "audio" &&
                        (call.body as { profileId: string }).profileId ===
                            "org-readonly",
                ),
            ).toBe(true),
        );
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
        expect(
            screen.queryByRole("combobox", { name: "AI for transcription" }),
        ).toBeNull();
        fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));

        expect(
            screen.queryByRole("heading", { name: "Transcribe" }),
        ).toBeNull();
        expect(screen.queryByRole("heading", { name: "Topics" })).toBeNull();
        expect(screen.getByRole("heading", { name: "Learn" })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Title" })).toBeTruthy();
        fireEvent.click(screen.getByRole("tab", { name: "Basic" }));
        expect(
            screen.getAllByRole("switch", { name: "Run automatically" }),
        ).toHaveLength(3);
    });

    it("shows the transcription provider in Basic for recording profiles", async () => {
        await edit("Default Profile");

        const provider = await screen.findByRole("combobox", {
            name: "AI for transcription",
        });
        expect(provider.textContent).toContain("ElevenLabs · scribe_v2");
        expect(
            screen.getByText(
                "Default uses your default transcription provider, then the Organization default, then Mynah when available.",
            ),
        ).toBeTruthy();
        expect(
            screen.getByText(
                "Sets the same provider pin for Learn, Title, Topics, and Summary. Default for each role uses your default for that role, then the Organization default, then your first enabled provider.",
            ),
        ).toBeTruthy();
    });

    it("updates the Advanced transcription pin and saved settings from Basic", async () => {
        await edit("Default Profile");

        fireEvent.change(
            await screen.findByRole("combobox", {
                name: "AI for transcription",
            }),
            { target: { value: "personal:transcription-ai" } },
        );
        fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
        expect(
            (
                screen.getByRole("combobox", {
                    name: "Transcribe provider",
                }) as HTMLSelectElement
            ).value,
        ).toBe("personal:transcription-ai");

        fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
        await waitFor(() =>
            expect(
                calls.some(
                    (call) =>
                        call.method === "PUT" &&
                        (call.body as { settings: AudioProfileSettings })
                            .settings.steps.transcribe.provider
                            ?.credentialId === "transcription-ai" &&
                        (call.body as { settings: AudioProfileSettings })
                            .settings.steps.transcribe.provider?.scope ===
                            "personal",
                ),
            ).toBe(true),
        );
    });

    it("disables the Basic transcription provider for read-only profiles", async () => {
        await renderList();
        fireEvent.click(
            screen.getByRole("button", { name: "View Org Profile" }),
        );

        expect(
            (
                await screen.findByRole("combobox", {
                    name: "AI for transcription",
                })
            ).hasAttribute("disabled"),
        ).toBe(true);
    });

    it("shows an unavailable provider pin and requires another choice", async () => {
        await edit("Unavailable Pin");
        fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));

        const select = screen.getByRole("combobox", {
            name: "Transcribe provider",
        }) as HTMLSelectElement;
        expect(select.selectedOptions[0]?.textContent).toBe(
            "Unavailable provider (choose another)",
        );
        expect(
            screen.getByText(
                "This pinned provider is disabled or no longer exists. Choose another provider before saving.",
            ),
        ).toBeTruthy();
    });

    it("uses the transcription language select with auto-detect", async () => {
        await edit("Default Profile");
        fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));

        const language = screen.getByRole("combobox", {
            name: "Language",
        }) as HTMLSelectElement;
        expect(language.options[0]?.textContent).toBe("Auto-detect");
        fireEvent.change(language, { target: { value: "cs" } });
        expect(language.value).toBe("cs");
    });

    it("offers Organization scope only to curators and restricts its providers", async () => {
        await renderList();
        expect(
            screen.queryByRole("combobox", { name: "New profile scope" }),
        ).toBeNull();
        cleanup();

        canCreateOrganization = true;
        await renderList();
        fireEvent.change(
            screen.getByRole("combobox", { name: "New profile scope" }),
            { target: { value: "organization" } },
        );
        fireEvent.click(
            screen.getByRole("button", {
                name: "New profile for recordings",
            }),
        );
        await screen.findByRole("dialog", {
            name: "Edit New recordings profile",
        });
        fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
        const provider = screen.getByRole("combobox", {
            name: "Transcribe provider",
        });
        expect(provider.textContent).toContain("Organization · Anthropic");
        expect(provider.textContent).not.toContain("OpenAI");

        fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
        await waitFor(() =>
            expect(
                calls.some(
                    (call) =>
                        call.url === "/api/settings/profiles" &&
                        call.method === "POST" &&
                        (call.body as { scope?: string }).scope ===
                            "organization",
                ),
            ).toBe(true),
        );
    });

    describe.each([
        {
            id: "personal-default",
            name: "Default Profile",
            description:
                "This profile will be removed from profile lists. Its processing history will be kept, and you can restore it from Archived.",
        },
        {
            id: "unavailable-pin",
            name: "Unavailable Pin",
            description:
                "This profile has no processing history and will be permanently deleted.",
        },
        {
            id: "last-personal",
            name: "Last Personal Profile",
            description:
                "This profile will be removed from profile lists. Its processing history will be kept, and you can restore it from Archived.",
        },
    ])("Delete confirmation for $name", ({ id, name, description }) => {
        it("explains the server-selected disposition before deleting", async () => {
            await renderList();
            fireEvent.click(
                screen.getByRole("button", { name: `Delete ${name}` }),
            );
            expect(await screen.findByText(`Delete “${name}”?`)).toBeTruthy();
            expect(await screen.findByText(description)).toBeTruthy();
            expect(
                calls.some(
                    (call) =>
                        call.url === `/api/settings/profiles/${id}` &&
                        call.method === "DELETE",
                ),
            ).toBe(false);
            fireEvent.click(screen.getByRole("button", { name: "Delete" }));
            await waitFor(() =>
                expect(
                    calls.some(
                        (call) =>
                            call.url === `/api/settings/profiles/${id}` &&
                            call.method === "DELETE",
                    ),
                ).toBe(true),
            );
        });
    });

    it("restores profiles from the archived filter", async () => {
        await renderList();
        fireEvent.change(screen.getByRole("combobox", { name: "Scope" }), {
            target: { value: "archived" },
        });
        await screen.findByText("Archived Profile");
        fireEvent.click(
            screen.getByRole("button", { name: "Restore Archived Profile" }),
        );
        await waitFor(() =>
            expect(
                calls.some(
                    (call) =>
                        call.url ===
                            "/api/settings/profiles/archived-profile/restore" &&
                        call.method === "POST",
                ),
            ).toBe(true),
        );
    });

    it("shows a 400 response message when saving fails validation", async () => {
        badRequest = true;
        await edit("Default Profile");
        fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
        await waitFor(() =>
            expect(toastError).toHaveBeenCalledWith("Choose another provider."),
        );
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
