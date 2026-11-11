// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderTree } from "@/components/dashboard/folder-tree";
import { RestrictedFolderProvider } from "@/components/sharing/restricted-folder-context";
import { RestrictedFolderControls } from "@/components/sharing/restricted-folder-controls";
import type { RecordingFolder } from "@/types/folder";

const { refresh, successToast } = vi.hoisted(() => ({
    refresh: vi.fn(),
    successToast: vi.fn(),
}));
vi.mock("@/hooks/use-dashboard-refresh", () => ({
    useDashboardRefresh: () => refresh,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: successToast } }));
vi.mock("@/lib/events/client", () => ({ subscribeEvents: () => () => {} }));

const root: RecordingFolder = {
    id: "org-root",
    name: "Organization",
    scope: "org",
    kind: "public",
    parentId: null,
    version: 1,
    sortOrder: 0,
};
const folder: RecordingFolder = {
    ...root,
    id: "project",
    name: "Project",
    kind: "custom",
    parentId: root.id,
};
const curator = { id: "curator", name: "Ada Fern", email: "ada@example.com" };
const creator = { id: "creator", name: "Bela Pine", email: "bela@example.com" };
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    fetchMock
        .mockReset()
        .mockImplementation(async () =>
            Response.json({ curators: [curator], creator }),
        );
    vi.stubGlobal("fetch", fetchMock);
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

describe.each([
    "tree",
    "header",
] as const)("restriction contacts from the %s", (variant) => {
    function mount(target = folder, canCurate = false, writable = true) {
        return render(
            <RestrictedFolderProvider writable={writable} userId="member">
                {variant === "tree" ? (
                    <FolderTree
                        folders={[root, target]}
                        assignments={[]}
                        recordings={[]}
                        selectedFolderId={target.id}
                        onRecent={vi.fn()}
                        onSelectFolder={vi.fn()}
                        onMoveFolder={vi.fn()}
                        onAssignRecording={vi.fn()}
                        onSettings={vi.fn()}
                        canCurate={canCurate}
                    />
                ) : (
                    <RestrictedFolderControls
                        folder={target}
                        folders={[root, target]}
                        canCurate={canCurate}
                    />
                )}
            </RestrictedFolderProvider>,
        );
    }
    function openMenu() {
        if (variant === "tree")
            fireEvent.pointerDown(
                screen.getByRole("button", {
                    name: "Folder actions for Project",
                }),
                { button: 0, ctrlKey: false },
            );
    }
    function restrictAction(label = "Restrict…") {
        return screen.getByRole(variant === "tree" ? "menuitem" : "button", {
            name: label,
        });
    }
    function openContacts() {
        mount();
        openMenu();
        fireEvent.click(restrictAction());
    }

    it("offers restriction to members and opens contacts with mail links", async () => {
        openContacts();
        const dialog = await screen.findByRole("dialog", {
            name: "Restrict this folder",
        });
        expect(await within(dialog).findByText(curator.name)).toBeTruthy();
        expect(
            within(dialog)
                .getByRole("link", { name: curator.email })
                .getAttribute("href"),
        ).toBe(`mailto:${curator.email}`);
        expect(within(dialog).getByText("Created by:")).toBeTruthy();
        expect(
            within(dialog)
                .getByRole("link", { name: creator.email })
                .getAttribute("href"),
        ).toBe(`mailto:${creator.email}`);
        expect(
            within(dialog).getByText(
                /Only curators of the Organization and the folder's creator/,
            ),
        ).toBeTruthy();
        expect(
            within(dialog).getByText(
                /Any member can create a new restricted subfolder/,
            ),
        ).toBeTruthy();
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/folders/project/restriction-contacts",
            { method: "GET" },
        );
        fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it.each([
        "creator",
        "curator",
    ])("opens the restriction preview for the %s", async (actor) => {
        fetchMock.mockImplementation(async () =>
            Response.json({
                items: [],
                withdrawnItems: [],
                audience: [],
                retainedAlmanacAdditions: [],
                exports: [],
            }),
        );
        mount(
            { ...folder, canRestrict: actor === "creator" },
            actor === "curator",
        );
        openMenu();
        fireEvent.click(restrictAction());
        expect(
            await screen.findByRole("dialog", { name: /Restrict folder/ }),
        ).toBeTruthy();
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/folders/project/restrict",
                { method: "GET" },
            ),
        );
        expect(screen.queryByText("Curators who can restrict it:")).toBeNull();
    });

    it.each([
        { writable: false, patch: {} },
        { writable: true, patch: { scope: "personal" as const } },
        { writable: true, patch: { kind: "public" as const } },
        { writable: true, patch: { restricted: true as const } },
        { writable: true, patch: { access: false } },
        { writable: true, patch: { restricting: true as const } },
    ])("keeps restriction hidden for ineligible folders: %j", ({
        writable,
        patch,
    }) => {
        mount({ ...folder, ...patch }, false, writable);
        openMenu();
        expect(
            screen.queryByRole(variant === "tree" ? "menuitem" : "button", {
                name: "Restrict…",
            }),
        ).toBeNull();
        expect(
            screen.queryByRole(variant === "tree" ? "menuitem" : "button", {
                name: "Retry restriction…",
            }),
        ).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
        "creator",
        "curator",
    ])("loads and submits %s retry of a curator-started transition", async (actor) => {
        fetchMock.mockImplementation(async (url, init) => {
            if (url === "/api/folders/project/restrict") {
                if (init?.method === "POST")
                    return Response.json({
                        restricted: true,
                        restricting: false,
                        queued: 0,
                    });
                return Response.json({
                    items: [],
                    audience: [curator],
                    withdrawnItems: [],
                    retainedAlmanacAdditions: [],
                    exports: [],
                });
            }
            if (url === "/api/folders/project/audience")
                return Response.json({ code: "NOT_FOUND" }, { status: 404 });
            throw new Error(`Unexpected request: ${url}`);
        });
        mount(
            { ...folder, restricting: true, canRestrict: actor === "creator" },
            actor === "curator",
        );
        openMenu();
        fireEvent.click(restrictAction("Retry restriction…"));
        const dialog = await screen.findByRole("dialog", {
            name: /Restrict folder/,
        });
        expect(await within(dialog).findByText(curator.name)).toBeTruthy();
        expect(within(dialog).queryByText("Loading…")).toBeNull();
        expect(within(dialog).queryByRole("alert")).toBeNull();
        const submit = within(dialog).getByRole("button", {
            name: "Restrict folder",
        });
        expect(submit).toHaveProperty("disabled", false);
        fireEvent.click(submit);
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(successToast).toHaveBeenCalledWith("Folder restricted");
        expect(refresh).toHaveBeenCalledOnce();
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/folders/project/restrict",
            { method: "GET" },
        );
        expect(
            fetchMock.mock.calls.every(
                ([url]) => url === "/api/folders/project/restrict",
            ),
        ).toBe(true);
        expect(
            fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
        ).toEqual([
            [
                "/api/folders/project/restrict",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ audienceUserIds: [] }),
                },
            ],
        ]);
    });

    it.each([
        null,
        curator,
    ])("omits a missing or curator creator: %j", async (value) => {
        fetchMock.mockImplementation(async () =>
            Response.json({ curators: [curator], creator: value }),
        );
        openContacts();
        expect(await screen.findByText(curator.name)).toBeTruthy();
        expect(
            screen.getAllByRole("link", { name: curator.email }),
        ).toHaveLength(1);
        expect(screen.queryByText("Created by:")).toBeNull();
    });

    it("shows administrator guidance without names when no curator is available", async () => {
        fetchMock.mockImplementation(async () =>
            Response.json({ curators: [], creator }),
        );
        openContacts();
        expect(
            await screen.findByText(
                "Ask the Organization's administrator to restrict this folder.",
            ),
        ).toBeTruthy();
        expect(screen.queryByText(creator.name)).toBeNull();
        expect(screen.queryByRole("link")).toBeNull();
    });

    it("shows loading until the contacts arrive", async () => {
        let finish: (response: Response) => void = () => {};
        fetchMock.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        openContacts();
        expect(screen.getByText("Loading…")).toBeTruthy();
        await act(async () =>
            finish(Response.json({ curators: [curator], creator: null })),
        );
        expect(screen.queryByText("Loading…")).toBeNull();
        expect(screen.getByText(curator.name)).toBeTruthy();
    });

    it("shows a localized error without server details", async () => {
        fetchMock.mockImplementation(async () =>
            Response.json(
                { code: "FORBIDDEN", error: "private details" },
                { status: 403 },
            ),
        );
        openContacts();
        expect((await screen.findByRole("alert")).textContent).toBe(
            "Could not load contacts. Please try again.",
        );
        expect(screen.queryByText("Loading…")).toBeNull();
        expect(screen.queryByText("private details")).toBeNull();
    });
});
