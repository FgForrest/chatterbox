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
import { afterEach, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { AgendaFolderTags } from "@/components/meetings/agenda-folder-tags";
import { useAgenda } from "@/components/meetings/use-agenda";
import type { RecordingFolderTags } from "@/components/recordings/recording-folder-tags";
import { detail } from "@/tests/meetings/ui-fixtures";
import type { RecordingFolder } from "@/types/folder";

const mock = vi.hoisted(() => ({ tags: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/events/client", () => ({ subscribeEvents: () => () => {} }));
vi.mock("@/components/recordings/recording-folder-tags", () => ({
    RecordingFolderTags: (props: unknown) => {
        mock.tags(props);
        return null;
    },
}));
const root: RecordingFolder = {
    id: "org",
    parentId: null,
    name: "Organization",
    scope: "org",
    kind: "public",
    sortOrder: 0,
    version: 1,
};
const r: RecordingFolder = {
    ...root,
    id: "r",
    parentId: "org",
    name: "Restricted R",
    restricted: true,
    access: true,
};
const a: RecordingFolder = {
    ...root,
    id: "a",
    parentId: "org",
    name: "Open A",
};
const b: RecordingFolder = { ...a, id: "b", name: "Open B" };
function tags(): ComponentProps<typeof RecordingFolderTags> {
    return mock.tags.mock.lastCall?.[0];
}
function Agenda({ openPlacement = false }: { openPlacement?: boolean }) {
    const initial = detail({
        folders: [r, ...(openPlacement ? [a] : [])].map((folder) => ({
            id: folder.id,
            name: folder.name,
            parentId: folder.parentId,
            userId: "org",
        })),
    });
    const agenda = useAgenda(initial.id, initial, { pollEnabled: false });
    return agenda.detail ? (
        <AgendaFolderTags
            detail={agenda.detail}
            userId="owner"
            disabled={false}
            folders={[root, r, a, b]}
            mutate={agenda.mutate}
        />
    ) : null;
}
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    mock.tags.mockClear();
});
it("moves open A to B with PATCH, retaining only R and B without a publication warning", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
    render(
        <ConfirmDialogProvider>
            <Agenda openPlacement />
        </ConfirmDialogProvider>,
    );
    await act(async () => {
        await tags().onMove?.("meeting", "a", "b");
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
        "/api/recordings/meeting/folders",
        expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({
                fromFolderId: "a",
                toFolderId: "b",
                withdraw: true,
            }),
        }),
    );
    expect(
        tags()
            .assignments.map((entry) => entry.folderId)
            .sort(),
    ).toEqual(["b", "r"]);
});
it("keeps R when its actual source is published, using POST after confirmation", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
    render(
        <ConfirmDialogProvider>
            <Agenda />
        </ConfirmDialogProvider>,
    );
    let result: Promise<void> | undefined;
    act(() => {
        result = tags().onMove?.("meeting", "r", "b");
    });
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(
        screen.getByRole("button", { name: "Share with the Organization" }),
    );
    await act(async () => {
        await result;
    });
    expect(fetch).toHaveBeenCalledWith(
        "/api/recordings/meeting/folders",
        expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ folderId: "b" }),
        }),
    );
    expect(
        tags()
            .assignments.map((entry) => entry.folderId)
            .sort(),
    ).toEqual(["b", "r"]);
});
it("rolls back a rejected confirmed move", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    render(
        <ConfirmDialogProvider>
            <Agenda />
        </ConfirmDialogProvider>,
    );
    let result: Promise<unknown> | undefined;
    act(() => {
        result = tags()
            .onMove?.("meeting", "r", "b")
            .catch((error: unknown) => error);
    });
    fireEvent.click(
        screen.getByRole("button", { name: "Share with the Organization" }),
    );
    await act(async () => {
        expect(await result).toBeInstanceOf(Error);
    });
    await waitFor(() =>
        expect(tags().assignments.map((entry) => entry.folderId)).toEqual([
            "r",
        ]),
    );
});
