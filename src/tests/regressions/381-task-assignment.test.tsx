// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RestrictedFolderProvider } from "@/components/sharing/restricted-folder-context";
import { TaskRow } from "@/components/tasks/task-row";
import { task } from "@/tests/meetings/ui-fixtures";

const mock = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: mock.error } }));
vi.mock("next-intl", () => ({
    useExtracted: () => (text: string, values?: Record<string, string>) =>
        text.replace(
            /\{(\w+)\}/g,
            (_match, key: string) => values?.[key] ?? "",
        ),
    useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
}));
vi.mock("@/components/tasks/assignee-picker", () => ({
    AssigneePicker: ({
        onChange,
    }: {
        onChange: (person: { personId: string; name: string } | null) => void;
    }) => (
        <button
            type="button"
            onClick={() =>
                onChange({ personId: "person", name: "Robin Fields" })
            }
        >
            Select Robin
        </button>
    ),
}));
function mount(reader?: Promise<Response>, failAddition = false) {
    const onChange = vi.fn();
    const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async (url, options) => {
            if (String(url).endsWith("/readers"))
                return (
                    reader ??
                    Response.json({
                        restricted: true,
                        organization: false,
                        readers: [],
                    })
                );
            if (String(url) === "/api/people/person")
                return Response.json({
                    person: { primaryEmail: "robin@example.com" },
                });
            if (String(url) === "/api/folders")
                return Response.json({
                    folders: [
                        {
                            id: "r",
                            name: "Acme pilot",
                            restricted: true,
                            access: true,
                            restrictedRole: "manager",
                        },
                    ],
                    assignments: [{ recordingId: "item", folderId: "r" }],
                });
            if (String(url).includes("/shares/people"))
                return Response.json({
                    people: [{ id: "member", email: "robin@example.com" }],
                });
            if (options?.method === "POST") {
                if (failAddition) throw new TypeError("offline");
                return Response.json({ skippedUserIds: [] });
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
    vi.stubGlobal("fetch", fetchMock);
    render(
        <RestrictedFolderProvider writable userId="owner">
            <ul>
                <TaskRow
                    task={task("task", null, {
                        recordingId: "item",
                        evidenceItemId: "item",
                    })}
                    organizationOnly
                    onChange={onChange}
                />
            </ul>
        </RestrictedFolderProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select Robin" }));
    return { onChange, fetchMock };
}
beforeEach(() => {
    vi.clearAllMocks();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});
it("defers TaskRow assignment through readers loading and audience addition", async () => {
    let resolve!: (response: Response) => void;
    const response = new Promise<Response>((done) => {
        resolve = done;
    });
    const { onChange } = mount(response);
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => {
        resolve(
            Response.json({
                restricted: true,
                organization: false,
                readers: [],
            }),
        );
    });
    await screen.findByText(/Robin Fields cannot see the folder Acme pilot/);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(
        screen.getByRole("button", { name: "Add to the audience" }),
    );
    await waitFor(() =>
        expect(onChange).toHaveBeenCalledExactlyOnceWith(
            { assigneePersonId: "person" },
            {
                assignee: { personId: "person", name: "Robin Fields" },
                assigneeHint: null,
                assigneeCheck: false,
            },
        ),
    );
});
it("cancels TaskRow assignment without a write", async () => {
    const { onChange, fetchMock } = mount();
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(
        fetchMock.mock.calls.some(([, options]) => options?.method === "POST"),
    ).toBe(false);
});
it("keeps TaskRow unassigned after audience addition fails, with an explicit Assign anyway choice", async () => {
    const { onChange } = mount(undefined, true);
    await screen.findByRole("alert");
    fireEvent.click(
        screen.getByRole("button", { name: "Add to the audience" }),
    );
    await waitFor(() => expect(mock.error).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Assign anyway" }));
    expect(onChange).toHaveBeenCalledTimes(1);
});
