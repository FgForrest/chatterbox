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
        { id: "profile-1", name: "Meetings" },
        { id: "profile-2", name: "Sales calls" },
    ],
    currentProfile: null,
    currentManualOnly: false,
    resolution: {
        status: "resolved",
        profile: { id: "profile-1", name: "Meetings" },
        manualOnly: false,
        source: "folder",
    },
};

function renderPanel(data: CategorizePanelData = base) {
    return render(
        <CategorizePanel
            data={data}
            open
            onOpenChange={vi.fn()}
            onCategorized={vi.fn()}
        />,
    );
}

function previewResponse(
    resolution: CategorizePanelData["resolution"],
): Response {
    return Response.json({ resolution });
}

describe("categorization panel", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("keeps roots disabled and shows a changeable resolved prefill", () => {
        renderPanel();

        expect(screen.queryByText("Suggested match")).toBeNull();
        expect(screen.getByText("From the folder's default")).toBeTruthy();
        expect(
            screen.getByRole("combobox", { name: "Profile" }).textContent,
        ).toContain("Meetings");
        expect(
            (screen.getByLabelText("Private") as HTMLInputElement).disabled,
        ).toBe(true);
        expect(
            (screen.getByLabelText("Organization") as HTMLInputElement)
                .disabled,
        ).toBe(true);

        fireEvent.click(screen.getByRole("combobox", { name: "Profile" }));
        expect(screen.getByText("Sales calls")).toBeTruthy();
        expect(screen.getByText("Nothing automatic")).toBeTruthy();
    });

    it("keeps the item's current profile when folders resolve differently", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        renderPanel({
            ...base,
            currentProfile: { id: "profile-2", name: "Sales calls" },
        });

        expect(
            screen.getByRole("combobox", { name: "Profile" }).textContent,
        ).toContain("Sales calls");
        expect(screen.getByText("Current profile")).toBeTruthy();

        fireEvent.click(screen.getByLabelText("Organization › Sales"));
        await new Promise((resolve) => window.setTimeout(resolve, 250));

        expect(fetchMock).not.toHaveBeenCalled();
        expect(
            screen.getByRole("combobox", { name: "Profile" }).textContent,
        ).toContain("Sales calls");
    });

    it.each([
        {
            name: "resolved",
            resolution: {
                status: "resolved" as const,
                profile: { id: "profile-2", name: "Sales calls" },
                manualOnly: false,
                source: "folder" as const,
            },
            expected: "Sales calls",
        },
        {
            name: "Nothing automatic",
            resolution: {
                status: "resolved" as const,
                profile: { id: "profile-1", name: "Meetings" },
                manualOnly: true,
                source: "folder" as const,
            },
            expected: "Nothing automatic",
        },
        {
            name: "choose",
            resolution: {
                status: "choose" as const,
                candidates: [
                    {
                        kind: "profile" as const,
                        profile: { id: "profile-1", name: "Meetings" },
                    },
                    { kind: "manual_only" as const },
                ],
            },
            expected: "Choose a profile",
        },
    ])("previews $name when the folder selection changes", async (testCase) => {
        const fetchMock = vi.fn(async () =>
            previewResponse(testCase.resolution),
        );
        vi.stubGlobal("fetch", fetchMock);
        renderPanel();

        fireEvent.click(screen.getByLabelText("Organization › Sales"));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/recordings/item-1/categorize/preview",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({ folderIds: ["notes", "sales"] }),
                }),
            ),
        );
        expect(
            screen.getByRole("combobox", { name: "Profile" }).textContent,
        ).toContain(testCase.expected);
    });

    it("submits no override when the prefilled choice is unchanged", async () => {
        const fetchMock = vi.fn(async () =>
            Response.json({ requestedGeneration: 2 }),
        );
        vi.stubGlobal("fetch", fetchMock);
        renderPanel();

        fireEvent.click(screen.getByRole("button", { name: "File it" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/recordings/item-1/categorize",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({ folderIds: ["notes"] }),
                }),
            ),
        );
    });

    it("submits only the changed profile override", async () => {
        const fetchMock = vi.fn(async () =>
            Response.json({ requestedGeneration: 2 }),
        );
        vi.stubGlobal("fetch", fetchMock);
        renderPanel();

        fireEvent.click(screen.getByRole("combobox", { name: "Profile" }));
        fireEvent.click(screen.getByText("Sales calls"));
        fireEvent.click(screen.getByRole("button", { name: "File it" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/recordings/item-1/categorize",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({
                        folderIds: ["notes"],
                        profileId: "profile-2",
                    }),
                }),
            ),
        );
    });

    it("submits Nothing automatic only when it replaces the prefill", async () => {
        const fetchMock = vi.fn(async () =>
            Response.json({ requestedGeneration: 2 }),
        );
        vi.stubGlobal("fetch", fetchMock);
        renderPanel();

        fireEvent.click(screen.getByRole("combobox", { name: "Profile" }));
        fireEvent.click(screen.getByText("Nothing automatic"));
        fireEvent.click(screen.getByRole("button", { name: "File it" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/recordings/item-1/categorize",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({
                        folderIds: ["notes"],
                        manualOnly: true,
                    }),
                }),
            ),
        );
    });

    it("creates and selects a folder when only roots exist", async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url === "/api/folders") {
                return Response.json(
                    {
                        folder: {
                            id: "new-folder",
                            parentId: "private-root",
                            name: "Clients",
                            scope: "personal",
                        },
                    },
                    { status: 201 },
                );
            }
            return previewResponse(base.resolution);
        });
        vi.stubGlobal("fetch", fetchMock);
        renderPanel({
            ...base,
            folders: base.folders.filter((folder) => folder.parentId === null),
            selectedFolderIds: [],
        });

        expect(
            screen.getByText("Create a folder to file this item"),
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "New folder" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), {
            target: { value: "Clients" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Create folder" }));

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
        expect(
            (screen.getByLabelText("Private › Clients") as HTMLInputElement)
                .checked,
        ).toBe(true);
    });
});
