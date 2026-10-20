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
import { ProfileRowActions } from "@/components/settings/profile-row-actions";
import { ProfilesSection } from "@/components/settings-sections/profiles-section";
import {
    type AudioProfileSettings,
    defaultProfileSettings,
} from "@/lib/profiles/settings";

const { toastError, toastSuccess, translate } = vi.hoisted(() => ({
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
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
    toast: { error: toastError, success: toastSuccess },
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
        deleteDisposition: "tombstone" as const,
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
        deleteDisposition: "tombstone" as const,
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
    let canCreatePersonal = true;
    let badRequest = false;
    let extraProfiles: typeof profiles = [];
    let emptyScopes: string[] = [];

    beforeEach(() => {
        calls = [];
        conflict = false;
        canCreateOrganization = false;
        canCreatePersonal = true;
        badRequest = false;
        extraProfiles = [];
        emptyScopes = [];
        toastError.mockClear();
        toastSuccess.mockClear();
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
                if (url.endsWith("/duplicate") && method === "POST") {
                    return Response.json({
                        profile: {
                            name:
                                body.scope === "organization"
                                    ? "Organization copy"
                                    : "Personal copy",
                        },
                    });
                }
                if (url.startsWith("/api/settings/profiles?")) {
                    const params = new URL(url, "https://example.test")
                        .searchParams;
                    const liveProfiles = [...profiles, ...extraProfiles].map(
                        (profile) => ({
                            ...profile,
                            canEdit:
                                profile.scope === "organization"
                                    ? canCreateOrganization
                                    : profile.canEdit,
                        }),
                    );
                    const archivedOrganization = {
                        ...archivedProfile,
                        id: "archived-organization",
                        name: "Archived Organization",
                        scope: "organization" as const,
                    };
                    const archives = [
                        archivedProfile,
                        ...(canCreateOrganization
                            ? [archivedOrganization]
                            : []),
                    ];
                    const listedProfiles =
                        params.get("archived") === "true"
                            ? archives
                            : liveProfiles;
                    function section(key: string) {
                        const rows = emptyScopes.includes(key)
                            ? []
                            : key === "archived"
                              ? archives
                              : liveProfiles.filter((p) => p.scope === key);
                        const page = Number(params.get(`${key}Page`) ?? 1);
                        return {
                            profiles: rows.slice((page - 1) * 10, page * 10),
                            pagination: {
                                page,
                                pageSize: 10,
                                total: rows.length,
                                totalPages: Math.ceil(rows.length / 10),
                            },
                        };
                    }
                    return Response.json({
                        profiles: listedProfiles,
                        sections: {
                            organization: section("organization"),
                            personal: section("personal"),
                            archived: section("archived"),
                        },
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
                        permissions: {
                            canCreateOrganization,
                            canCreatePersonal,
                        },
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

    async function renderList(waitForButton = "Edit Default Profile") {
        render(
            <ConfirmDialogProvider>
                <ProfilesSection />
            </ConfirmDialogProvider>,
        );
        await screen.findByRole("button", { name: waitForButton });
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

        await waitFor(() =>
            expect(
                calls.some(
                    (call) =>
                        call.url ===
                        "/api/settings/profiles?q=meeting&channel=mail&sectioned=true&organizationPage=1&personalPage=1&archivedPage=1&pageSize=10",
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
        fireEvent.pointerDown(
            screen.getByRole("button", {
                name: "More actions: Default Profile",
            }),
            { button: 0, ctrlKey: false, pointerType: "mouse" },
        );
        expect(
            await screen.findByRole("menuitem", { name: "Delete…" }),
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
                "Default uses your default transcription provider, then the Organization default, then its oldest enabled transcription provider.",
            ),
        ).toBeTruthy();
        expect(
            screen.getByText(
                "Sets the same provider pin for Learn, Title, Topics, and Summary. Default uses your role choice, then your summary choice for following roles, then the Organization role and summary defaults, then your first enabled chat provider, then the Organization’s oldest enabled chat provider.",
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
            await screen.findByRole("dialog", { name: "View Org Profile" }),
        ).toBeTruthy();
        expect(
            screen.queryByRole("dialog", { name: "Edit Org Profile" }),
        ).toBeNull();
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
    ])("Delete confirmation for $name", ({ id, name }) => {
        it("explains permanent deletion before deleting", async () => {
            await renderList();
            fireEvent.pointerDown(
                screen.getByRole("button", { name: `More actions: ${name}` }),
                { button: 0, ctrlKey: false, pointerType: "mouse" },
            );
            fireEvent.click(
                await screen.findByRole("menuitem", { name: "Delete…" }),
            );
            expect(
                await screen.findByText(
                    `Delete profile “${name}” permanently?`,
                ),
            ).toBeTruthy();
            expect(
                await screen.findByText(
                    "The profile disappears and cannot be restored. Recordings, summaries and tasks made with it stay.",
                ),
            ).toBeTruthy();
            expect(
                calls.some(
                    (call) =>
                        call.url === `/api/settings/profiles/${id}` &&
                        call.method === "DELETE",
                ),
            ).toBe(false);
            fireEvent.click(
                screen.getByRole("button", { name: "Delete permanently" }),
            );
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

    it("disables deleting the effective personal default without an Organization fallback", async () => {
        await renderList();
        fireEvent.pointerDown(
            screen.getByRole("button", { name: "More actions: Mail Profile" }),
            { button: 0, ctrlKey: false, pointerType: "mouse" },
        );
        const remove = await screen.findByRole("menuitem", { name: "Delete…" });
        expect(remove.getAttribute("aria-disabled")).toBe("true");
        const reason = screen.getByText(
            "Choose another default for mail before deleting this profile. There is no Organization default to take over.",
        );
        expect(remove.getAttribute("aria-describedby")).toBe(reason.id);
        expect(remove.getAttribute("data-variant")).not.toBe("destructive");
        fireEvent.click(remove);
        expect(screen.queryByRole("alertdialog")).toBeNull();
        expect(
            calls.some(
                (call) =>
                    call.url.endsWith("/mail-profile") &&
                    call.method === "DELETE",
            ),
        ).toBe(false);
    });

    it("allows deleting an effective personal default when an Organization default can take over", async () => {
        const personal = profiles[0];
        if (!personal) throw new Error("Missing personal fixture");
        extraProfiles = [
            {
                ...personal,
                id: "personal-effective",
                name: "Personal Effective",
                isYourDefault: true,
            },
        ];
        await renderList();
        fireEvent.pointerDown(
            screen.getByRole("button", {
                name: "More actions: Personal Effective",
            }),
            { button: 0, ctrlKey: false, pointerType: "mouse" },
        );
        const remove = await screen.findByRole("menuitem", { name: "Delete…" });
        expect(remove.getAttribute("aria-disabled")).not.toBe("true");
        fireEvent.click(remove);
        expect(
            await screen.findByRole("alertdialog", {
                name: "Delete profile “Personal Effective” permanently?",
            }),
        ).toBeTruthy();
    });

    it("restores profiles from the collapsible Archived section", async () => {
        await renderList();
        fireEvent.click(screen.getByRole("button", { name: "Hide" }));
        expect(screen.queryByText("Archived Profile")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Show" }));
        await screen.findByText("Archived Profile");
        const row = screen.getByText("Archived Profile").closest("li");
        expect(row?.classList.contains("bg-muted/60")).toBe(true);
        expect(
            screen
                .getByText("Archived Profile")
                .classList.contains("text-muted-foreground"),
        ).toBe(true);
        const date = screen.getByText("Archived Oct 15, 2026");
        expect(date.closest("p")?.textContent).toContain("for recordings");
        expect(date.closest("p")?.textContent).toContain("Personal");
        expect(date.tagName).toBe("TIME");
        expect(date.getAttribute("datetime")).toBe(archivedProfile.archivedAt);
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
    it("groups profiles with counts and hides archived Organization rows from members", async () => {
        await renderList();
        expect(
            screen.getByRole("heading", { name: "Organization" }),
        ).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Personal" })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Archived" })).toBeTruthy();
        expect(screen.queryByRole("combobox", { name: "Scope" })).toBeNull();
        expect(screen.queryByText("Archived Organization")).toBeNull();
        expect(
            screen.queryByRole("button", { name: "More actions: Org Profile" }),
        ).toBeNull();
        expect(
            screen.getByRole("button", {
                name: "Duplicate to personal Org Profile",
            }).textContent,
        ).toContain("Duplicate to personal profiles");
    });

    it.each([
        "Org Profile",
        "Default Profile",
    ])("offers a curator both duplicate destinations for %s", async (name) => {
        canCreateOrganization = true;
        await renderList();
        fireEvent.pointerDown(
            screen.getByRole("button", { name: `Duplicate ${name}` }),
            { button: 0, ctrlKey: false, pointerType: "mouse" },
        );
        const menu = await screen.findByRole("menu");
        expect(
            menu.classList.contains("max-w-[min(20rem,calc(100vw-1.5rem))]"),
        ).toBe(true);
        fireEvent.click(
            await screen.findByRole("menuitem", {
                name: /To the Organization/,
            }),
        );
        await waitFor(() =>
            expect(
                calls.some(
                    (c) =>
                        c.url.endsWith(
                            `/${name === "Org Profile" ? "org-readonly" : "personal-default"}/duplicate`,
                        ) &&
                        (c.body as { scope?: string })?.scope ===
                            "organization",
                ),
            ).toBe(true),
        );
        await waitFor(() =>
            expect(toastSuccess).toHaveBeenCalledWith(
                "Copied to the Organization as “Organization copy”.",
            ),
        );
        fireEvent.pointerDown(
            screen.getByRole("button", { name: `Duplicate ${name}` }),
            { button: 0, ctrlKey: false, pointerType: "mouse" },
        );
        fireEvent.click(
            await screen.findByRole("menuitem", {
                name: /To personal profiles/,
            }),
        );
        await waitFor(() =>
            expect(
                calls.some(
                    (c) =>
                        c.url.endsWith("/duplicate") &&
                        (c.body as { scope?: string })?.scope === "personal",
                ),
            ).toBe(true),
        );
        await waitFor(() =>
            expect(toastSuccess).toHaveBeenCalledWith(
                "Copied to personal profiles as “Personal copy”.",
            ),
        );
    });

    it("shows a disabled archive action with the channel-specific reason on the Organization default", async () => {
        canCreateOrganization = true;
        await renderList();
        fireEvent.pointerDown(
            screen.getByRole("button", { name: "More actions: Org Profile" }),
            { button: 0, ctrlKey: false, pointerType: "mouse" },
        );
        const archive = await screen.findByRole("menuitem", {
            name: /^Archive…/,
        });
        expect(archive.getAttribute("data-variant")).not.toBe("destructive");
        expect(
            screen.queryByText(
                "Disappears from profile choices. Can be restored.",
            ),
        ).toBeNull();
        expect(archive.getAttribute("aria-disabled")).toBe("true");
        expect(
            screen.getByText(
                "The Organization default cannot be archived. First make another profile the default for recordings.",
            ),
        ).toBeTruthy();
        expect(
            screen.queryByRole("menuitem", {
                name: "Make Organization default",
            }),
        ).toBeNull();
        fireEvent.click(archive);
        expect(
            calls.some(
                (c) => c.url.endsWith("/org-readonly") && c.method === "DELETE",
            ),
        ).toBe(false);
    });

    it("confirms permanent deletion for an archived Organization profile before calling its endpoint", async () => {
        canCreateOrganization = true;
        await renderList();
        fireEvent.pointerDown(
            screen.getByRole("button", {
                name: "More actions: Archived Organization",
            }),
            { button: 0, ctrlKey: false, pointerType: "mouse" },
        );
        const remove = await screen.findByRole("menuitem", {
            name: /^Delete permanently…/,
        });
        expect(remove.getAttribute("data-variant")).not.toBe("destructive");
        expect(
            screen.getByText("Archived profiles only. Cannot be undone."),
        ).toBeTruthy();
        fireEvent.click(remove);
        const dialog = await screen.findByRole("alertdialog", {
            name: "Delete profile “Archived Organization” permanently?",
        });
        expect(dialog.textContent).toContain(
            "The profile disappears and cannot be restored.",
        );
        expect(calls.some((c) => c.url.endsWith("/permanent"))).toBe(false);
        fireEvent.click(
            within(dialog).getByRole("button", { name: "Delete permanently" }),
        );
        await waitFor(() =>
            expect(
                calls.some(
                    (c) =>
                        c.url.endsWith("/archived-organization/permanent") &&
                        c.method === "DELETE",
                ),
            ).toBe(true),
        );
    });

    it("paginates sections independently and resets pages when the channel changes", async () => {
        const personal = profiles[0];
        if (!personal) throw new Error("Missing personal fixture");
        extraProfiles = Array.from({ length: 12 }, (_, index) => ({
            ...personal,
            id: `extra-${index}`,
            name: `Extra ${index}`,
        }));
        await renderList();
        const navigation = screen.getByRole("navigation", {
            name: "Personal profile pages",
        });
        fireEvent.click(
            within(navigation).getByRole("button", { name: "Next page" }),
        );
        await waitFor(() =>
            expect(
                calls.some((c) =>
                    c.url.includes(
                        "organizationPage=1&personalPage=2&archivedPage=1",
                    ),
                ),
            ).toBe(true),
        );
        expect(
            await screen.findByRole("button", { name: "View Org Profile" }),
        ).toBeTruthy();
        fireEvent.change(screen.getByRole("combobox", { name: "Channel" }), {
            target: { value: "mail" },
        });
        await waitFor(() =>
            expect(
                calls.some(
                    (c) =>
                        c.url.includes("channel=mail") &&
                        c.url.includes("personalPage=1"),
                ),
            ).toBe(true),
        );
    });
    it("does not offer a personal copy to the local Organization account", async () => {
        canCreateOrganization = true;
        canCreatePersonal = false;
        await renderList();
        expect(
            screen.queryByRole("combobox", { name: "New profile scope" }),
        ).toBeNull();
        fireEvent.pointerDown(
            screen.getByRole("button", { name: "Duplicate Org Profile" }),
            { button: 0, ctrlKey: false, pointerType: "mouse" },
        );
        expect(
            await screen.findByRole("menuitem", {
                name: /To the Organization/,
            }),
        ).toBeTruthy();
        expect(
            screen.queryByRole("menuitem", { name: /To personal profiles/ }),
        ).toBeNull();
    });
    it.each([
        true,
        false,
    ])("disables the %s Edit/View control while its row mutates", (canEdit) => {
        const fixture = profiles[0];
        if (!fixture) throw new Error("Missing fixture");
        const onEdit = vi.fn();
        render(
            <ProfileRowActions
                profile={{ ...fixture, canEdit }}
                canCreateOrganization={false}
                disabled
                onEdit={onEdit}
                onAction={vi.fn()}
            />,
        );
        const button = screen.getByRole("button", {
            name: `${canEdit ? "Edit" : "View"} ${fixture.name}`,
        });
        expect(button.hasAttribute("disabled")).toBe(true);
        fireEvent.click(button);
        expect(onEdit).not.toHaveBeenCalled();
    });

    it("keeps phone row actions on a full-width line and badges unbroken", async () => {
        await renderList();
        const button = screen.getByRole("button", { name: "View Org Profile" });
        const row = button.closest("li");
        expect(row?.classList.contains("@container")).toBe(true);
        expect(button.parentElement?.classList.contains("w-full")).toBe(true);
        expect(
            button.parentElement?.classList.contains("@min-[560px]:w-auto"),
        ).toBe(true);
        const name = row && within(row).getByText("Org Profile");
        expect(
            name?.parentElement?.parentElement?.classList.contains(
                "basis-full",
            ),
        ).toBe(true);
        expect(
            screen
                .getByText("Organization default")
                .classList.contains("whitespace-nowrap"),
        ).toBe(true);
    });

    it("lets the profile header wrap controls and stacks both default labels", async () => {
        canCreateOrganization = true;
        await renderList();
        const scope = screen.getByRole("combobox", {
            name: "New profile scope",
        });
        expect(
            scope.parentElement?.parentElement?.classList.contains("flex-wrap"),
        ).toBe(true);
        const header = screen.getByRole("heading", { name: "Profiles" })
            .parentElement?.parentElement;
        expect(header?.classList.contains("flex-wrap")).toBe(true);
        expect(
            header?.classList.contains("[&>div:last-child]:max-w-full"),
        ).toBe(true);
        for (const label of ["Default for recordings", "Default for mail"]) {
            expect(
                screen
                    .getByText(label, { selector: "label" })
                    .classList.contains("block"),
            ).toBe(true);
        }
    });

    it("shows neutral lock and people icons in the Organization row metadata", async () => {
        await renderList();
        expect(
            screen.getByText("Read-only").querySelector("svg.lucide-lock"),
        ).toBeTruthy();
        const row = screen
            .getByRole("button", { name: "View Org Profile" })
            .closest("li");
        expect(row?.querySelector("p svg.lucide-users")).toBeTruthy();
        expect(
            row
                ?.querySelector("p")
                ?.classList.contains("text-muted-foreground"),
        ).toBe(true);
    });

    it.each([
        ["personal", "No personal profiles yet.", "View Org Profile"],
        [
            "organization",
            "No Organization profiles yet.",
            "Edit Default Profile",
        ],
    ])("shows a first-use %s section message until filters are active", async (scope, emptyMessage, waitForButton) => {
        emptyScopes = [scope];
        await renderList(waitForButton);
        expect(screen.getByText(emptyMessage)).toBeTruthy();
        expect(
            screen.queryByText("No profiles match these filters."),
        ).toBeNull();
        fireEvent.change(
            screen.getByRole("searchbox", { name: "Search profiles" }),
            { target: { value: "absent" } },
        );
        expect(
            await screen.findByText("No profiles match these filters."),
        ).toBeTruthy();
        expect(screen.queryByText(emptyMessage)).toBeNull();
        fireEvent.change(
            screen.getByRole("searchbox", { name: "Search profiles" }),
            { target: { value: "" } },
        );
        expect(await screen.findByText(emptyMessage)).toBeTruthy();
        fireEvent.change(screen.getByRole("combobox", { name: "Channel" }), {
            target: { value: "mail" },
        });
        expect(
            await screen.findByText("No profiles match these filters."),
        ).toBeTruthy();
    });

    it("shows the normal archive subtext only for a non-default Organization profile", async () => {
        canCreateOrganization = true;
        const fixture = profiles[1];
        if (!fixture) throw new Error("Missing Organization fixture");
        extraProfiles = [
            {
                ...fixture,
                id: "org-other",
                name: "Other Organization",
                isOrganizationDefault: false,
            },
        ];
        await renderList();
        fireEvent.pointerDown(
            screen.getByRole("button", {
                name: "More actions: Other Organization",
            }),
            { button: 0, ctrlKey: false, pointerType: "mouse" },
        );
        const archive = await screen.findByRole("menuitem", {
            name: /^Archive…/,
        });
        expect(archive.getAttribute("aria-disabled")).not.toBe("true");
        expect(
            within(archive).getByText(
                "Disappears from profile choices. Can be restored.",
            ),
        ).toBeTruthy();
    });
});
