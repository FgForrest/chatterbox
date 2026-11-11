// @vitest-environment jsdom
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NewFolderForm } from "@/components/pipeline/new-folder-form";
import type { RecordingFolder } from "@/types/folder";

const root: RecordingFolder = {
    id: "root",
    name: "Private",
    kind: "private",
    scope: "personal",
    parentId: null,
    sortOrder: 0,
    version: 0,
};
const project: RecordingFolder = {
    ...root,
    id: "project",
    name: "Projects",
    kind: "custom",
    parentId: root.id,
};
const parents = [
    { id: root.id, path: "Private", folder: root },
    { id: project.id, path: "Private › Projects", folder: project },
];
beforeEach(() => {
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

it("prefills the query and chooses a parent with shared search and paths", async () => {
    const created = {
        ...project,
        id: "created",
        parentId: project.id,
        name: "Planning",
    };
    const fetch = vi.fn().mockResolvedValue(Response.json({ folder: created }));
    vi.stubGlobal("fetch", fetch);
    const onCreated = vi.fn();
    render(
        <NewFolderForm
            parents={parents}
            idPrefix="test"
            initialName="Planning"
            onCancel={vi.fn()}
            onCreated={onCreated}
        />,
    );
    expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveProperty(
        "value",
        "Planning",
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Parent folder" }));
    fireEvent.change(screen.getByPlaceholderText("Find a folder…"), {
        target: { value: "project" },
    });
    fireEvent.click(screen.getByRole("option", { name: "Projects Private" }));
    expect(
        screen.getByRole("combobox", { name: "Parent folder" }).textContent,
    ).toBe("Private › Projects");
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(fetch).toHaveBeenCalledWith(
        "/api/folders",
        expect.objectContaining({
            body: JSON.stringify({ parentId: "project", name: "Planning" }),
        }),
    );
});
it("keeps the name and selected parent when creation fails", async () => {
    vi.stubGlobal(
        "fetch",
        vi
            .fn()
            .mockResolvedValue(
                Response.json({ error: "Unavailable" }, { status: 500 }),
            ),
    );
    const onCreated = vi.fn();
    render(
        <NewFolderForm
            parents={parents}
            idPrefix="test"
            initialName="Planning"
            onCancel={vi.fn()}
            onCreated={onCreated}
        />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() =>
        expect(
            screen.getByRole("button", { name: "Create folder" }),
        ).toHaveProperty("disabled", false),
    );
    expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveProperty(
        "value",
        "Planning",
    );
    expect(
        screen.getByRole("combobox", { name: "Parent folder" }).textContent,
    ).toBe("Private");
    expect(onCreated).not.toHaveBeenCalled();
});
it("updates available parents and refuses creation with no allowed parent", () => {
    const view = render(
        <NewFolderForm
            parents={parents}
            idPrefix="test"
            initialName="Planning"
            onCancel={vi.fn()}
            onCreated={vi.fn()}
        />,
    );
    view.rerender(
        <NewFolderForm
            parents={[parents[1]]}
            idPrefix="test"
            initialName="Planning"
            onCancel={vi.fn()}
            onCreated={vi.fn()}
        />,
    );
    expect(
        screen.getByRole("combobox", { name: "Parent folder" }).textContent,
    ).toBe("Private › Projects");
    view.rerender(
        <NewFolderForm
            parents={[]}
            idPrefix="test"
            initialName="Planning"
            onCancel={vi.fn()}
            onCreated={vi.fn()}
        />,
    );
    expect(
        screen.getByRole("button", { name: "Create folder" }),
    ).toHaveProperty("disabled", true);
});

it("removes shared parents live and submits to an available private parent", async () => {
    const fetch = vi
        .fn()
        .mockResolvedValue(
            Response.json({ folder: { ...project, id: "new" } }),
        );
    vi.stubGlobal("fetch", fetch);
    const view = render(
        <NewFolderForm
            parents={[parents[1], parents[0]]}
            idPrefix="test"
            initialName="Acme plans"
            onCancel={vi.fn()}
            onCreated={vi.fn()}
        />,
    );
    view.rerender(
        <NewFolderForm
            parents={[
                {
                    ...parents[1],
                    folder: { ...project, sharedWithPeople: true },
                },
                parents[0],
            ]}
            idPrefix="test"
            initialName="Acme plans"
            onCancel={vi.fn()}
            onCreated={vi.fn()}
        />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Parent folder" }));
    expect(
        screen.queryByRole("option", { name: "Projects Private" }),
    ).toBeNull();
    fireEvent.keyDown(screen.getByPlaceholderText("Find a folder…"), {
        key: "Escape",
    });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() =>
        expect(fetch).toHaveBeenCalledWith(
            "/api/folders",
            expect.objectContaining({
                body: JSON.stringify({ parentId: "root", name: "Acme plans" }),
            }),
        ),
    );
});
it("localizes a shared-parent refusal after a stale folder choice", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
            Response.json(
                {
                    code: "SHARED_FOLDER_HAS_NO_SUBFOLDERS",
                    error: "Server text",
                },
                { status: 409 },
            ),
        ),
    );
    const error = vi.spyOn(toast, "error");
    render(
        <NewFolderForm
            parents={parents}
            idPrefix="test"
            initialName="Acme plans"
            onCancel={vi.fn()}
            onCreated={vi.fn()}
        />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() =>
        expect(error).toHaveBeenCalledWith(
            "A shared folder has no subfolders.",
        ),
    );
    error.mockRestore();
});
