// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { ItemWorkflow } from "@/components/pipeline/item-workflow";
import { RestrictedFolderProvider } from "@/components/sharing/restricted-folder-context";
import type { CategorizationPanelPresentation } from "@/lib/pipeline/categorization-presentation";
import { processingFixture } from "@/tests/pipeline/processing-fixture";
import type { RecordingFolder } from "@/types/folder";

vi.mock("@/lib/events/client", () => ({ subscribeEvents: () => () => {} }));
vi.mock("@/components/tasks/task-api", () => ({
    onTasksChanged: () => () => {},
}));
const root: RecordingFolder = {
    id: "org",
    parentId: null,
    name: "Organization",
    kind: "public",
    scope: "org",
    version: 1,
    sortOrder: 0,
};
const r: RecordingFolder = {
    ...root,
    id: "r",
    parentId: root.id,
    kind: "custom",
    name: "Acme pilot",
    restricting: true,
    access: true,
};
const b: RecordingFolder = {
    ...r,
    id: "b",
    name: "Open B",
    restricting: undefined,
};
const processing = processingFixture({
    itemId: "item",
    kind: "audio",
    legacy: false,
    manualOnly: false,
    phases: {
        categorize: {
            state: "waiting",
            reason: "needs_folder",
            generation: 1,
            at: "2026-11-01T12:00:00Z",
        },
    },
    profile: null,
    placements: [],
    intents: [],
    outputs: { transcript: false, summary: false, learn: false },
    processAgain: false,
    processAgainReason: null,
    learnFindingsWaiting: 0,
    taskReviewWaiting: 0,
    jobs: { transcription: null, summary: null },
    failures: [],
});
const profile = { id: "p", name: "Owner profile", scope: "personal" as const };
const data: CategorizationPanelPresentation = {
    itemId: "item",
    folders: [root, r, b].map((folder) => ({ ...folder, path: folder.name })),
    selectedFolderIds: ["r"],
    profiles: [profile],
    currentProfile: null,
    currentManualOnly: false,
    canCreateOrganizationFolders: true,
    resolution: {
        status: "resolved",
        profile,
        manualOnly: true,
        source: "default",
    },
};
const onChanged = vi.fn();
function mount(write: () => Promise<Response>) {
    let loads = 0;
    const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async (url, options) => {
            if (String(url).endsWith("/categorize")) {
                if (options?.method === "POST") return write();
                loads++;
                return Response.json(
                    loads === 1
                        ? data
                        : {
                              ...data,
                              folders: data.folders.map((folder) =>
                                  folder.id === "r"
                                      ? { ...folder, access: false }
                                      : folder,
                              ),
                          },
                );
            }
            if (String(url).endsWith("/preview"))
                return Response.json({ resolution: data.resolution });
            return Response.json({ processing });
        });
    vi.stubGlobal("fetch", fetchMock);
    render(
        <RestrictedFolderProvider writable userId="owner">
            <ConfirmDialogProvider>
                <ItemWorkflow
                    itemId="item"
                    kind="audio"
                    initialData={processing}
                    folders={[root, r, b]}
                    folderAssignments={[{ recordingId: "item", folderId: "r" }]}
                    onSelectFolder={vi.fn()}
                    onAddToFolder={vi.fn()}
                    onRemoveFromFolder={vi.fn()}
                    onChanged={onChanged}
                />
            </ConfirmDialogProvider>
        </RestrictedFolderProvider>,
    );
    return {
        fetchMock,
        loads: () => loads,
        writes: () =>
            fetchMock.mock.calls.filter(
                ([url, options]) =>
                    String(url).endsWith("/categorize") &&
                    options?.method === "POST",
            ),
    };
}
async function selectOpenFolder() {
    await screen.findByRole("combobox", { name: "Folder" });
    fireEvent.click(screen.getByRole("combobox", { name: "Folder" }));
    fireEvent.click(screen.getByRole("option", { name: /Open B/ }));
    await waitFor(() =>
        expect(
            screen.getByRole("button", { name: "Categorize recording" }),
        ).toHaveProperty("disabled", false),
    );
}
beforeEach(() => {
    onChanged.mockClear();
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            disconnect() {}
            unobserve() {}
        },
    );
    Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});
it("a needs-folder workflow carries transitioning R through cancel and confirmed publication", async () => {
    const state = mount(async () => Response.json({}));
    await selectOpenFolder();
    fireEvent.click(
        screen.getByRole("button", { name: "Categorize recording" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(state.writes()).toHaveLength(0);
    fireEvent.click(
        screen.getByRole("button", { name: "Categorize recording" }),
    );
    fireEvent.click(
        screen.getByRole("button", { name: "Share with the Organization" }),
    );
    await waitFor(() => expect(state.writes()).toHaveLength(1));
    expect(JSON.parse(String(state.writes()[0][1]?.body))).toEqual({
        folderIds: ["b", "r"],
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
});
it.each([
    403, 409,
])("refetches the panel/item after %s without SSE and preserves local choices", async (status) => {
    const state = mount(async () =>
        Response.json(
            { code: "RESTRICTED_FOLDER_NO_ACCESS", error: "refused" },
            { status },
        ),
    );
    await selectOpenFolder();
    fireEvent.click(screen.getByRole("combobox", { name: "Profile" }));
    fireEvent.click(screen.getByRole("option", { name: "Owner profile" }));
    fireEvent.click(
        screen.getByRole("button", { name: "Categorize recording" }),
    );
    fireEvent.click(
        screen.getByRole("button", { name: "Share with the Organization" }),
    );
    await waitFor(() => expect(state.loads()).toBe(2));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(
        screen.getByRole("combobox", { name: "Folder" }).textContent,
    ).toContain("Open B");
    expect(
        screen.getByRole("combobox", { name: "Profile" }).textContent,
    ).toContain("Owner profile");
    expect(
        state.fetchMock.mock.calls.some(([url]) =>
            String(url).includes("processing=1"),
        ),
    ).toBe(true);
});
it("rolls back rejected confirmed categorization without losing the open destination", async () => {
    const state = mount(async () => {
        throw new TypeError("offline");
    });
    await selectOpenFolder();
    fireEvent.click(
        screen.getByRole("button", { name: "Categorize recording" }),
    );
    fireEvent.click(
        screen.getByRole("button", { name: "Share with the Organization" }),
    );
    await waitFor(() => expect(state.writes()).toHaveLength(1));
    await waitFor(() =>
        expect(
            screen.getByRole("button", { name: "Categorize recording" }),
        ).toHaveProperty("disabled", false),
    );
    expect(
        screen.getByRole("combobox", { name: "Folder" }).textContent,
    ).toContain("Open B");
    expect(onChanged).not.toHaveBeenCalled();
});
