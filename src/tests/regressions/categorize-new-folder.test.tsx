// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemWorkflow } from "@/components/pipeline/item-workflow";
import type { CategorizationPanelPresentation } from "@/lib/pipeline/categorization-presentation";
import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";
import { processingFixture } from "@/tests/pipeline/processing-fixture";
import type { RecordingFolder } from "@/types/folder";

vi.mock("next-intl", () => ({
    useLocale: () => "en",
    useExtracted:
        () =>
        (
            value: string | { message: string },
            params?: Record<string, unknown>,
        ) => {
            const message = typeof value === "string" ? value : value.message;
            return message.replace(/\{(\w+)\}/g, (_, key: string) =>
                String(params?.[key] ?? ""),
            );
        },
}));
vi.mock("@/components/tasks/task-api", () => ({
    onTasksChanged: () => () => {},
}));

const root: RecordingFolder = {
    id: "root-velno",
    parentId: null,
    name: "Private",
    kind: "private",
    scope: "personal",
    sortOrder: 0,
    version: 0,
};
const existing: RecordingFolder = {
    ...root,
    id: "folder-tavri",
    parentId: root.id,
    name: "Tavri",
    kind: "custom",
};
const added: RecordingFolder = {
    ...existing,
    id: "folder-zulno",
    name: "Zulno",
};
const inline: RecordingFolder = {
    ...existing,
    id: "folder-felvo",
    name: "Felvo",
};
const profile = {
    id: "profile-nelvi",
    name: "Nelvi",
    scope: "personal" as const,
};

function processing(
    itemId = "item-velno",
    kind: "audio" | "mail" = "audio",
    arrived = true,
) {
    return processingFixture({
        itemId,
        kind,
        legacy: false,
        manualOnly: false,
        phases: arrived
            ? {
                  categorize: {
                      state: "waiting",
                      reason: "needs_folder",
                      generation: 1,
                      at: "2026-10-22T10:00:00Z",
                  },
              }
            : {},
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
}
function panel(
    folders = [root, existing],
    itemId = "item-velno",
): CategorizationPanelPresentation {
    return {
        itemId,
        canCreateOrganizationFolders: false,
        folders: folders.map((folder) => ({
            ...folder,
            path: folder.parentId ? `Private › ${folder.name}` : folder.name,
        })),
        selectedFolderIds: [],
        profiles: [profile],
        currentProfile: null,
        currentManualOnly: false,
        resolution: {
            status: "resolved",
            profile,
            manualOnly: true,
            source: "default",
        },
    };
}
function props(
    kind: "audio" | "mail" = "audio",
): ComponentProps<typeof ItemWorkflow> {
    return {
        itemId: "item-velno",
        kind,
        initialData: processing("item-velno", kind),
        folders: [root, existing],
        folderAssignments: [],
        onSelectFolder: vi.fn(),
        onAddToFolder: vi.fn(),
        onRemoveFromFolder: vi.fn(),
    };
}
function deferredResponse() {
    let resolve: (response: Response) => void = () => {};
    const promise = new Promise<Response>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
function mockFetch(getPanel: (url: string) => Promise<Response>) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/categorize")) return getPanel(url);
        if (url === "/api/folders") return Response.json({ folder: inline });
        if (url.endsWith("/preview"))
            return Response.json({ resolution: panel().resolution });
        if (url.startsWith("/api/settings/profiles/")) return Response.json({});
        throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}
function folderControl() {
    return screen.getByRole("combobox", { name: "Folder" });
}
function profileControl() {
    return screen.getByRole("combobox", { name: "Profile" });
}

beforeEach(() => {
    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
    });
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("Categorize folders stay live", () => {
    it.each([
        "audio",
        "mail",
    ] as const)("adds a private folder in the background without resetting %s choices", async (kind) => {
        const refresh = deferredResponse();
        const getPanel = vi
            .fn()
            .mockResolvedValueOnce(Response.json(panel()))
            .mockReturnValueOnce(refresh.promise);
        mockFetch(getPanel);
        const initial = props(kind);
        const { rerender } = render(<ItemWorkflow {...initial} />);
        await screen.findByRole("combobox", { name: "Folder" });
        const card = screen.getByRole("region", {
            name: kind === "mail" ? "Categorize email" : "Categorize recording",
        });
        fireEvent.click(folderControl());
        fireEvent.click(
            screen.getByRole("option", { name: "Private › Tavri" }),
        );
        await waitFor(() =>
            expect(profileControl().hasAttribute("disabled")).toBe(false),
        );
        fireEvent.click(profileControl());
        fireEvent.click(screen.getByRole("option", { name: "Nelvi" }));
        rerender(
            <ItemWorkflow {...initial} folders={[added, existing, root]} />,
        );
        expect(getPanel).toHaveBeenCalledTimes(2);
        expect(screen.queryByText("Loading filing choices…")).toBeNull();
        expect(folderControl().textContent).toContain("Tavri");
        await act(async () => {
            refresh.resolve(Response.json(panel([root, existing, added])));
        });
        expect(
            screen.getByRole("region", {
                name:
                    kind === "mail"
                        ? "Categorize email"
                        : "Categorize recording",
            }),
        ).toBe(card);
        expect(folderControl().textContent).toContain("Tavri");
        expect(profileControl().textContent).toContain("Nelvi");
        fireEvent.click(folderControl());
        expect(
            screen.getByRole("option", { name: "Private › Zulno" }),
        ).toBeTruthy();
        fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
        rerender(
            <ItemWorkflow
                {...initial}
                folders={[{ ...root }, { ...existing }, { ...added }]}
            />,
        );
        expect(getPanel).toHaveBeenCalledTimes(2);
    });

    it.each([
        "audio",
        "mail",
    ] as const)("keeps an inline-created %s folder selected even when the refetch omits it", async (kind) => {
        const refresh = deferredResponse();
        const getPanel = vi
            .fn()
            .mockResolvedValueOnce(Response.json(panel()))
            .mockReturnValueOnce(refresh.promise);
        mockFetch(getPanel);
        const initial = props(kind);
        const onFolderCreated = vi.fn();
        const { rerender } = render(
            <ItemWorkflow {...initial} onFolderCreated={onFolderCreated} />,
        );
        await screen.findByRole("combobox", { name: "Folder" });
        fireEvent.click(folderControl());
        fireEvent.click(screen.getByRole("option", { name: "New folder…" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), {
            target: { value: "Felvo" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Create" }));
        await waitFor(() =>
            expect(onFolderCreated).toHaveBeenCalledWith(inline),
        );
        expect(folderControl().textContent).toContain("Felvo");
        rerender(
            <ItemWorkflow
                {...initial}
                folders={[root, existing, inline]}
                onFolderCreated={onFolderCreated}
            />,
        );
        await act(async () => {
            refresh.resolve(Response.json(panel()));
        });
        expect(folderControl().textContent).toContain("Felvo");
        expect(
            screen
                .getByRole("button", {
                    name:
                        kind === "mail"
                            ? "Categorize email"
                            : "Categorize recording",
                })
                .hasAttribute("disabled"),
        ).toBe(false);
        fireEvent.click(folderControl());
        expect(
            screen.getAllByRole("option", { name: "Private › Felvo" }),
        ).toHaveLength(1);
    });

    it("uses server renames and moves, removes deleted server folders, and deduplicates inline folders", async () => {
        const getPanel = vi.fn().mockResolvedValueOnce(Response.json(panel()));
        mockFetch(getPanel);
        const initial = props();
        const onFolderCreated = vi.fn();
        const { rerender } = render(
            <ItemWorkflow {...initial} onFolderCreated={onFolderCreated} />,
        );
        await screen.findByRole("combobox", { name: "Folder" });
        fireEvent.click(folderControl());
        fireEvent.click(screen.getByRole("option", { name: "New folder…" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), {
            target: { value: "Felvo" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Create" }));
        await waitFor(() => expect(onFolderCreated).toHaveBeenCalled());
        const renamed = { ...inline, name: "Felnora", parentId: added.id };
        getPanel.mockResolvedValueOnce(
            Response.json(panel([root, added, renamed])),
        );
        rerender(
            <ItemWorkflow {...initial} folders={[root, added, renamed]} />,
        );
        await waitFor(() =>
            expect(folderControl().textContent).toContain("Felnora"),
        );
        fireEvent.click(folderControl());
        expect(
            screen.getAllByRole("option", { name: "Private › Felnora" }),
        ).toHaveLength(1);
        expect(
            screen.queryByRole("option", { name: "Private › Tavri" }),
        ).toBeNull();
    });

    it("ignores stale folder responses, including when switching away and back to an item", async () => {
        const old = deferredResponse();
        const fresh = deferredResponse();
        const getPanel = vi
            .fn()
            .mockReturnValueOnce(old.promise)
            .mockResolvedValueOnce(
                Response.json(panel([root, added], "item-zurna")),
            )
            .mockReturnValueOnce(fresh.promise);
        mockFetch(getPanel);
        const initial = props();
        const { rerender } = render(<ItemWorkflow {...initial} />);
        rerender(
            <ItemWorkflow
                {...initial}
                itemId="item-zurna"
                initialData={processing("item-zurna")}
            />,
        );
        await screen.findByRole("combobox", { name: "Folder" });
        rerender(<ItemWorkflow {...initial} />);
        await act(async () => {
            old.resolve(Response.json(panel()));
        });
        expect(screen.queryByRole("combobox", { name: "Folder" })).toBeNull();
        await act(async () => {
            fresh.resolve(Response.json(panel([root, added])));
        });
        fireEvent.click(folderControl());
        expect(
            screen.getByRole("option", { name: "Private › Zulno" }),
        ).toBeTruthy();
        expect(
            screen.queryByRole("option", { name: "Private › Tavri" }),
        ).toBeNull();
    });
});

describe("File later upload arrival", () => {
    it("shows the strip and Categorize card when the worker catches up after the first processing read", async () => {
        vi.useFakeTimers();
        const itemId = "upload-velnora";
        invalidateItemProcessing(itemId);
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input).endsWith("/categorize"))
                return Response.json(panel([root, existing], itemId));
            return Response.json({
                processing: processing(
                    itemId,
                    "audio",
                    fetchMock.mock.calls.length > 1,
                ),
            });
        });
        vi.stubGlobal("fetch", fetchMock);
        render(
            <ItemWorkflow
                {...props()}
                itemId={itemId}
                initialData={undefined}
            />,
        );
        await act(async () => {});
        expect(
            screen.queryByRole("region", { name: "Categorize recording" }),
        ).toBeNull();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(3_000);
        });
        expect(
            screen.getByRole("region", { name: "Categorize recording" }),
        ).toBeTruthy();
        expect(screen.getByRole("button", { name: "File it" })).toBeTruthy();
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("bounds rapid arrival refreshes and returns to the server's idle deadline", async () => {
        vi.useFakeTimers();
        const itemId = "upload-tavrola";
        invalidateItemProcessing(itemId);
        const fetchMock = vi.fn(async () =>
            Response.json({ processing: processing(itemId, "audio", false) }),
        );
        vi.stubGlobal("fetch", fetchMock);
        render(
            <ItemWorkflow
                {...props()}
                itemId={itemId}
                initialData={undefined}
            />,
        );
        await act(async () => {});
        for (let index = 0; index < 10; index++) {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(3_000);
            });
        }
        expect(fetchMock).toHaveBeenCalledTimes(11);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(59_999);
        });
        expect(fetchMock).toHaveBeenCalledTimes(11);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });
        expect(fetchMock).toHaveBeenCalledTimes(12);
    });
});
