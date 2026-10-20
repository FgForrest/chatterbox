// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    CategorizePanel,
    type CategorizePanelData,
} from "@/components/pipeline/categorize-panel";

vi.mock("next-intl", () => ({
    useLocale: () => "en",
    useExtracted: () => (text: string, values?: Record<string, unknown>) =>
        text.replace(/\{(\w+)\}/g, (_match, key: string) =>
            String(values?.[key] ?? ""),
        ),
}));

const base: CategorizePanelData = {
    itemId: "item-1",
    canCreateOrganizationFolders: true,
    folders: [
        {
            id: "private-root",
            parentId: null,
            name: "Private",
            path: "Private",
            scope: "personal",
        },
        {
            id: "notes",
            parentId: "private-root",
            name: "Notes",
            path: "Private › Notes",
            scope: "personal",
        },
        {
            id: "org-root",
            parentId: null,
            name: "Organization",
            path: "Organization",
            scope: "org",
        },
        {
            id: "sales",
            parentId: "org-root",
            name: "Sales",
            path: "Organization › Sales",
            scope: "org",
        },
    ],
    selectedFolderIds: ["notes"],
    profiles: [
        { id: "profile-1", name: "Meetings", scope: "personal" },
        { id: "profile-2", name: "Sales calls", scope: "personal" },
    ],
    currentProfile: null,
    currentManualOnly: false,
    resolution: {
        status: "resolved",
        profile: { id: "profile-1", name: "Meetings", scope: "personal" },
        manualOnly: false,
        source: "folder",
    },
};

const details = {
    "profile-1": {
        description: "Discussion, decisions, and tasks.",
        automatic: {
            transcribe: true,
            learn: true,
            summary: true,
            title: true,
            topics: true,
        },
    },
    "profile-2": {
        description: "Follow-ups from sales conversations.",
        automatic: {
            transcribe: false,
            learn: false,
            summary: true,
            title: false,
            topics: false,
        },
    },
};

function renderPanel(
    data: CategorizePanelData = base,
    props: Partial<React.ComponentProps<typeof CategorizePanel>> = {},
) {
    return render(
        <CategorizePanel
            data={data}
            kind="audio"
            mode="folder"
            profileDetails={details}
            onCategorized={vi.fn()}
            {...props}
        />,
    );
}

describe("CategorizePanel", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it.each([
        "audio",
        "mail",
    ] as const)("encloses folder and profile symmetrically for %s, including folder creation", (kind) => {
        renderPanel(base, { kind });
        const folder = screen.getByRole("group", { name: "Folder" });
        const profile = screen.getByRole("group", { name: "Profile" });
        expect(folder.tagName).toBe("FIELDSET");
        expect(profile.tagName).toBe("FIELDSET");
        expect(profile.className).toBe(folder.className);
        expect(profile.parentElement).toBe(folder.parentElement);
        expect(folder.parentElement?.classList.contains("sm:grid-cols-2")).toBe(
            true,
        );
        expect(
            profile.contains(screen.getByRole("combobox", { name: "Profile" })),
        ).toBe(true);
        expect(
            profile.contains(
                screen.getByRole("link", {
                    name: "Manage profiles in Settings → Profiles.",
                }),
            ),
        ).toBe(true);

        fireEvent.click(screen.getByRole("combobox", { name: "Folder" }));
        fireEvent.click(screen.getByText("New folder…"));
        expect(
            folder.contains(
                screen.getByRole("textbox", { name: "Folder name" }),
            ),
        ).toBe(true);
        expect(profile.className).toBe(folder.className);
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(
            folder.contains(screen.getByRole("combobox", { name: "Folder" })),
        ).toBe(true);
    });

    it("is an inline filing card with one folder and profile dropdown", () => {
        renderPanel();
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(
            screen.getByRole("heading", { name: "Categorize recording" }),
        ).toBeTruthy();
        expect(screen.getByRole("combobox", { name: "Folder" })).toBeTruthy();
        const profile = screen.getByRole("combobox", { name: "Profile" });
        expect(profile).toBeTruthy();
        expect(profile.hasAttribute("data-filing-profile")).toBe(true);
        expect(
            screen.getByText("Discussion, decisions, and tasks."),
        ).toBeTruthy();
        expect(
            screen.getByText(
                "After categorizing, these run by themselves: transcription, Learn, summary, title, and topics.",
            ),
        ).toBeTruthy();
        expect(
            screen.getByRole("link", {
                name: "Manage profiles in Settings → Profiles.",
            }),
        ).toHaveProperty("href", expect.stringContaining("/settings#profiles"));
    });

    it("requires a folder when the item has no placement", () => {
        renderPanel({ ...base, selectedFolderIds: [] });

        expect(
            screen.getByRole("combobox", { name: "Folder" }).textContent,
        ).toContain("Choose a folder");
        expect(
            screen
                .getByRole("button", { name: "Categorize recording" })
                .hasAttribute("disabled"),
        ).toBe(true);
    });

    it("keeps the carried placement in choose-profile mode", () => {
        renderPanel(base, { mode: "profile" });

        expect(
            screen.getByRole("combobox", { name: "Folder" }).textContent,
        ).toContain("Private › Notes");
    });

    it("hides the profile description panel when the description is empty", () => {
        renderPanel(base, {
            profileDetails: {
                ...details,
                "profile-1": { ...details["profile-1"], description: null },
            },
        });

        expect(screen.queryByText("No profile description.")).toBeNull();
        expect(screen.queryByText(/^Meetings:/)).toBeNull();
    });

    it("offers Nothing automatic last and updates the automation panel", () => {
        renderPanel();
        fireEvent.click(screen.getByRole("combobox", { name: "Profile" }));
        fireEvent.click(screen.getByText("Nothing automatic"));
        expect(
            screen.getByText(
                "Nothing runs automatically. You start each step yourself.",
            ),
        ).toBeTruthy();
    });

    it("offers Organization default and Organization profiles without personal profiles", () => {
        const organizationProfile = {
            id: "org-profile",
            name: "Organization recordings",
            scope: "organization" as const,
        };
        renderPanel({
            ...base,
            profiles: [organizationProfile],
            organizationDefault: organizationProfile,
            followsOrganizationDefault: true,
            resolution: {
                status: "resolved",
                profile: organizationProfile,
                manualOnly: false,
                source: "default",
            },
        });

        const profile = screen.getByRole("combobox", { name: "Profile" });
        expect(profile.textContent).toContain(
            "Organization default (Organization recordings)",
        );
        fireEvent.click(profile);
        expect(
            screen.getByText("Organization recordings · Organization"),
        ).toBeTruthy();
    });

    it("shows an archived or access-revoked Organization default as unavailable", () => {
        renderPanel({
            ...base,
            defaultProfileUnavailable: true,
            resolution: { status: "choose", candidates: [] },
        });

        expect(
            screen.getByText("Unavailable Organization profile"),
        ).toBeTruthy();
        expect(
            screen.getByText(
                "Your selected Organization profile is unavailable. Choose another default.",
            ),
        ).toBeTruthy();
        expect(
            screen
                .getByRole("button", { name: "Categorize recording" })
                .hasAttribute("disabled"),
        ).toBe(true);
    });

    it("uses a resolved folder profile when the account default is unavailable", () => {
        renderPanel({
            ...base,
            defaultProfileUnavailable: true,
        });

        expect(
            screen.getByRole("combobox", { name: "Profile" }).textContent,
        ).toContain("Meetings");
        expect(
            screen.queryByText("Unavailable Organization profile"),
        ).toBeNull();
        expect(
            screen.queryByText(
                "Your selected Organization profile is unavailable. Choose another default.",
            ),
        ).toBeNull();
        expect(
            screen
                .getByRole("button", { name: "Categorize recording" })
                .hasAttribute("disabled"),
        ).toBe(false);
    });

    it("creates a first-level folder without a parent picker", async () => {
        const onFolderCreated = vi.fn();
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input) === "/api/folders") {
                return Response.json(
                    {
                        folder: {
                            id: "new-folder",
                            parentId: "private-root",
                            name: "Clients",
                            kind: "custom",
                            sortOrder: 0,
                            scope: "personal",
                            version: 0,
                        },
                    },
                    { status: 201 },
                );
            }
            return Response.json({ resolution: base.resolution });
        });
        vi.stubGlobal("fetch", fetchMock);
        renderPanel(base, { onFolderCreated });

        fireEvent.click(screen.getByRole("combobox", { name: "Folder" }));
        fireEvent.click(screen.getByText("New folder…"));
        expect(screen.queryByText("Parent folder")).toBeNull();
        fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), {
            target: { value: "Clients" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Create" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/folders",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({
                        parentId: "private-root",
                        name: "Clients",
                    }),
                }),
            ),
        );
        expect(onFolderCreated).toHaveBeenCalled();
        expect(
            screen.getByRole("combobox", { name: "Folder" }).textContent,
        ).toContain("Clients");
    });

    it("posts the single folder and chosen profile optimistically", async () => {
        const onOptimisticCategorize = vi.fn(() => vi.fn());
        const fetchMock = vi.fn(async () =>
            Response.json({ requestedGeneration: 2 }),
        );
        vi.stubGlobal("fetch", fetchMock);
        renderPanel(base, { onOptimisticCategorize });

        fireEvent.click(screen.getByRole("combobox", { name: "Profile" }));
        fireEvent.click(screen.getByText("Sales calls"));
        fireEvent.click(
            screen.getByRole("button", { name: "Categorize recording" }),
        );

        const submission = { folderIds: ["notes"], profileId: "profile-2" };
        expect(onOptimisticCategorize).toHaveBeenCalledWith(submission);
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/recordings/item-1/categorize",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify(submission),
                }),
            ),
        );
    });

    it("shows and focuses the profile reason in choose-profile mode", () => {
        renderPanel(
            {
                ...base,
                resolution: {
                    status: "choose",
                    candidates: [
                        { kind: "profile", profile: base.profiles[0] },
                        { kind: "manual_only" },
                    ],
                },
            },
            { mode: "profile", reason: "needs_profile" },
        );
        expect(
            screen.getByText(
                "These folders suggest different profiles. Choose one to continue.",
            ),
        ).toBeTruthy();
        expect(document.activeElement).toBe(
            screen.getByRole("combobox", { name: "Profile" }),
        );
    });

    it("shows no automation loader until a profile is chosen", () => {
        renderPanel(
            {
                ...base,
                currentProfile: null,
                resolution: { status: "choose", candidates: [] },
            },
            {
                mode: "profile",
                reason: "needs_profile",
                profileDetails: {},
            },
        );

        expect(screen.queryByText("Loading profile automation…")).toBeNull();
    });

    it("offers Transcribe now only for audio", () => {
        const onTranscribe = vi.fn();
        const { rerender } = render(
            <CategorizePanel
                data={base}
                kind="audio"
                mode="folder"
                profileDetails={details}
                onTranscribe={onTranscribe}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Transcribe now" }));
        expect(onTranscribe).toHaveBeenCalledOnce();

        rerender(
            <CategorizePanel
                data={base}
                kind="mail"
                mode="folder"
                profileDetails={details}
            />,
        );
        expect(
            screen.queryByRole("button", { name: "Transcribe now" }),
        ).toBeNull();
    });
});
