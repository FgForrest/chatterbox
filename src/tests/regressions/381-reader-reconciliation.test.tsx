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
import { FolderAccessRequest } from "@/components/sharing/folder-access-request";
import { RestrictedAudienceDialog } from "@/components/sharing/restricted-audience-dialog";
import { RestrictedFolderProvider } from "@/components/sharing/restricted-folder-context";
import { RestrictedItemAudience } from "@/components/sharing/restricted-item-audience";
import type { ClientEvent } from "@/lib/events/types";
import type { RecordingFolder } from "@/types/folder";

const mock = vi.hoisted(() => ({
    refresh: vi.fn(),
    error: vi.fn(),
    listener: null as ((event: ClientEvent) => void) | null,
}));
vi.mock("@/hooks/use-dashboard-refresh", () => ({
    useDashboardRefresh: () => mock.refresh,
}));
vi.mock("@/lib/events/client", () => ({
    subscribeEvents: (listener: (event: ClientEvent) => void) => {
        mock.listener = listener;
        return () => {};
    },
}));
vi.mock("sonner", () => ({ toast: { error: mock.error } }));
const folder: RecordingFolder = {
    id: "locked",
    name: "Acme pilot",
    parentId: "org",
    scope: "org",
    kind: "custom",
    sortOrder: 0,
    version: 1,
    restricted: true,
    access: true,
    accessRequest: "none",
};
const owner = {
    userId: "owner",
    name: "Robin Fields",
    email: "robin@example.com",
};
const privatePerson = {
    userId: "member",
    name: "Lada Cloudfern",
    email: "lada@example.com",
};
const readers = {
    ownerUserId: "owner",
    restricted: true,
    organization: false,
    curatorsCanRead: true,
    readers: [owner, privatePerson],
};
function deferred() {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
beforeEach(() => {
    vi.clearAllMocks();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});
it("supersedes full readers A with redacted B even when A resolves last", async () => {
    const a = deferred();
    const b = deferred();
    const fetchMock = vi
        .fn<typeof fetch>()
        .mockReturnValueOnce(a.promise)
        .mockReturnValueOnce(b.promise);
    vi.stubGlobal("fetch", fetchMock);
    render(
        <RestrictedFolderProvider writable userId="owner">
            <RestrictedItemAudience itemId="item" />
        </RestrictedFolderProvider>,
    );
    act(() => mock.listener?.({ type: "share" }));
    await act(async () => {
        b.resolve(Response.json({ ...readers, readers: [owner] }));
    });
    expect(
        screen.getByText("Visible to the folder's audience and curators"),
    ).toBeTruthy();
    await act(async () => {
        a.resolve(Response.json(readers));
    });
    expect(screen.queryByRole("img", { name: privatePerson.name })).toBeNull();
    expect(screen.queryByText("Visible to")).toBeNull();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
});
it("clears displayed metadata on invalidation and rejects a previous viewer's response", async () => {
    const stale = deferred();
    const latest = deferred();
    const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(readers))
        .mockReturnValueOnce(stale.promise)
        .mockReturnValueOnce(latest.promise);
    vi.stubGlobal("fetch", fetchMock);
    const view = (userId: string) => (
        <RestrictedFolderProvider writable userId={userId}>
            <RestrictedItemAudience itemId="item" />
        </RestrictedFolderProvider>
    );
    const { rerender } = render(view("member"));
    await screen.findByRole("img", { name: privatePerson.name });
    act(() => mock.listener?.({ type: "tree" }));
    expect(screen.queryByRole("img")).toBeNull();
    rerender(view("owner"));
    await act(async () => {
        stale.resolve(Response.json(readers));
        latest.resolve(Response.json({ ...readers, readers: [owner] }));
    });
    expect(screen.queryByRole("img")).toBeNull();
});
it("inspects audience read-only without the endpoint that refuses read-only requests", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) =>
        String(url).endsWith("/access-requests")
            ? Response.json(
                  {
                      code: "FORBIDDEN",
                      error: "The Organization is read-only on this instance",
                  },
                  { status: 403 },
              )
            : Response.json({
                  members: [
                      {
                          ...privatePerson,
                          role: "member",
                          ownsItems: false,
                      },
                  ],
                  role: "member",
              }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
        <RestrictedFolderProvider writable={false} userId="member">
            <RestrictedAudienceDialog folder={folder} onOpenChange={vi.fn()} />
        </RestrictedFolderProvider>,
    );
    await screen.findByText(`${privatePerson.name} (you)`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/audience$/);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add people" })).toBeNull();
});
it.each([
    "audience",
    "access-requests",
])("keeps the successful reader when %s GET fails", async (failed) => {
    vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockImplementation(async (url) =>
            String(url).endsWith(`/${failed}`)
                ? Response.json(
                      {
                          code: "FORBIDDEN",
                          error: "The Organization is read-only on this instance",
                      },
                      { status: 403 },
                  )
                : String(url).endsWith("/audience")
                  ? Response.json({
                        members: [
                            {
                                ...privatePerson,
                                role: "member",
                                ownsItems: false,
                            },
                        ],
                        role: "member",
                    })
                  : Response.json({
                        requests: [
                            { id: "request", ...owner, state: "pending" },
                        ],
                    }),
        ),
    );
    render(
        <RestrictedFolderProvider writable userId="member">
            <RestrictedAudienceDialog folder={folder} onOpenChange={vi.fn()} />
        </RestrictedFolderProvider>,
    );
    await screen.findAllByText(
        failed === "audience" ? owner.name : `${privatePerson.name} (you)`,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
});
it.each([
    403, 409,
])("rolls back and refreshes an access request refused with %s without SSE", async (status) => {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
            Response.json(
                {
                    code:
                        status === 403
                            ? "FORBIDDEN"
                            : "STALE_FOLDER_ACCESS_REQUEST",
                    error: "refused",
                },
                { status },
            ),
        ),
    );
    render(
        <RestrictedFolderProvider writable userId="owner">
            <FolderAccessRequest folder={folder} />
        </RestrictedFolderProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Request access" }));
    expect(screen.getByText(/Request sent/)).toBeTruthy();
    await waitFor(() => expect(mock.refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Request access" })).toBeTruthy();
    expect(screen.queryByText(/Request sent/)).toBeNull();
});
it("rolls back a rejected access-request fetch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    render(
        <RestrictedFolderProvider writable userId="owner">
            <FolderAccessRequest folder={folder} />
        </RestrictedFolderProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Request access" }));
    await waitFor(() => expect(mock.error).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Request access" })).toBeTruthy();
});

it("keeps a successful audience reload after a decision when the requests reload fails", async () => {
    let written = false;
    vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
            if (options?.method === "PATCH") {
                written = true;
                return Response.json({});
            }
            if (String(url).endsWith("/audience"))
                return Response.json({
                    role: "member",
                    members: written
                        ? [
                              {
                                  ...privatePerson,
                                  role: "member",
                                  ownsItems: false,
                              },
                          ]
                        : [],
                });
            return written
                ? Response.json(
                      { code: "INTERNAL_ERROR", error: "unavailable" },
                      { status: 500 },
                  )
                : Response.json({
                      requests: [{ id: "request", ...owner, state: "pending" }],
                  });
        }),
    );
    render(
        <RestrictedFolderProvider writable userId="member">
            <RestrictedAudienceDialog folder={folder} onOpenChange={vi.fn()} />
        </RestrictedFolderProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(mock.error).toHaveBeenCalled());
    expect(screen.getByText(`${privatePerson.name} (you)`)).toBeTruthy();
});
