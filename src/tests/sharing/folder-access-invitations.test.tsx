// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import type { TranslationValues } from "use-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
    type Invitation,
    PersonInvitations,
    PersonSharingProvider,
} from "@/components/sharing/person-sharing";
import { RestrictedFolderProvider } from "@/components/sharing/restricted-folder-context";
import { translatedSourceMessage } from "@/lib/i18n/messages";

const mocks = vi.hoisted(() => ({
    locale: "en" as "en" | "cs-CZ",
    refresh: vi.fn(),
    invitations: [] as Invitation[],
    onEvent: (_event: { type: string }) => {},
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: mocks.refresh, replace: vi.fn() }),
    usePathname: () => "/dashboard",
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-intl", () => ({
    useExtracted: () => translate,
    useLocale: () => mocks.locale,
    useFormatter: () => ({
        dateTime: () => "10 November",
        list: (values: string[]) => values.join(", "),
    }),
}));
vi.mock("@/lib/events/client", () => ({
    subscribeEvents: (listener: typeof mocks.onEvent) => {
        mocks.onEvent = listener;
        return () => {};
    },
}));
vi.mock("sonner", () => ({
    toast: { custom: vi.fn(), dismiss: vi.fn(), error: vi.fn() },
}));
function translate(
    message: string | { message: string },
    values?: TranslationValues,
) {
    return translatedSourceMessage(
        mocks.locale,
        typeof message === "string" ? message : message.message,
        values,
    );
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.locale = "en";
    mocks.invitations = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url) =>
            Response.json(
                url === "/api/shares"
                    ? { invitations: mocks.invitations }
                    : { updated: true },
            ),
        ),
    );
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});
function show(
    state: "pending" | "approved" | "declined" = "pending",
    writable = true,
    notifications = false,
    open = true,
) {
    const invitation: Invitation = {
        id: "request",
        folderId: "folder",
        folderName: "Acme",
        userId: "requester",
        name: "Jitka Dvořáková",
        state,
        invitedAt: new Date("2026-11-10T12:00:00Z"),
        decidedAt: null,
        title: "Acme",
        ownerName: "Jitka Dvořáková",
        itemId: "folder",
        kind: "folder-access",
        notice: state !== "pending",
    };
    mocks.invitations = [invitation];
    render(
        <RestrictedFolderProvider writable={writable} userId="approver">
            <PersonSharingProvider value>
                <PersonInvitations
                    notifications={notifications}
                    folders={[]}
                    initialInvitations={[invitation]}
                />
            </PersonSharingProvider>
        </RestrictedFolderProvider>,
    );
    if (open)
        fireEvent.click(
            screen.getByRole("button", {
                name: translate("Invitations ({count})", { count: "1" }),
            }),
        );
}
it.each([
    "en",
    "cs-CZ",
] as const)("approves an access request directly from invitations in %s", async (locale) => {
    mocks.locale = locale;
    show();
    expect(
        screen.getByRole("link", { name: "Acme" }).getAttribute("href"),
    ).toBe("/dashboard?folder=folder");
    expect(screen.getByText(translate("Access request"))).toBeTruthy();
    expect(
        screen.getByText(
            translate("{person} requests access to this restricted folder.", {
                person: "Jitka Dvořáková",
            }),
        ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: translate("Approve") }));
    await waitFor(() =>
        expect(fetch).toHaveBeenCalledWith(
            "/api/folders/folder/access-requests/request",
            expect.objectContaining({
                method: "PATCH",
                body: JSON.stringify({ state: "approved" }),
            }),
        ),
    );
    expect(screen.queryByText("Acme")).toBeNull();
    expect(
        screen.queryByRole("dialog", { name: translate("Accept folder") }),
    ).toBeNull();
});
it("declines an access request", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() =>
        expect(fetch).toHaveBeenCalledWith(
            "/api/folders/folder/access-requests/request",
            expect.objectContaining({
                body: JSON.stringify({ state: "declined" }),
            }),
        ),
    );
});
it.each([
    "approved",
    "declined",
] as const)("shows and dismisses the requester's %s decision notice", async (state) => {
    show(state);
    expect(
        screen.getByText(
            state === "approved"
                ? "Your access request was approved."
                : "Your access request was declined. You may request again.",
        ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
        expect(fetch).toHaveBeenCalledWith(
            "/api/folders/folder/access-requests/request",
            expect.objectContaining({
                body: JSON.stringify({ state: "dismissed" }),
            }),
        ),
    );
});
it("restores a request card if the server refuses stale authority", async () => {
    vi.mocked(fetch).mockResolvedValue(
        Response.json(
            { code: "FORBIDDEN", error: "Access changed" },
            { status: 403 },
        ),
    );
    show();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByText("Acme")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
});

it("keeps approver cards readable but hides decisions outside writable Organization mode", () => {
    show("pending", false);
    expect(screen.getByRole("link", { name: "Acme" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
});

it.each([
    "approved",
    "declined",
    "cancelled",
])("removes another approver's %s request notice and card on a share reload", async () => {
    show("pending", true, true, false);
    expect(toast.custom).toHaveBeenCalledOnce();
    mocks.invitations = [];
    await act(async () => mocks.onEvent({ type: "share" }));
    await waitFor(() =>
        expect(
            screen.queryByRole("button", { name: "Invitations (1)" }),
        ).toBeNull(),
    );
    expect(toast.dismiss).toHaveBeenCalledWith("new-item");
    expect(toast.error).not.toHaveBeenCalled();
});

it("opens a stale corner notice onto the refreshed empty list without a refusal", async () => {
    show("pending", true, true, false);
    const notice = vi.mocked(toast.custom).mock.calls.at(-1)?.[0];
    expect(notice).toBeDefined();
    render(notice?.("new-item"));
    mocks.invitations = [];
    fireEvent.click(screen.getByRole("button", { name: 'Open "Acme"' }));
    await waitFor(() =>
        expect(
            screen.getByRole("button", {
                name: "Invitations (0)",
                hidden: true,
            }),
        ).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Acme" })).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
});

it("refreshes a stale decision conflict without displaying an error", async () => {
    show();
    mocks.invitations = [];
    vi.mocked(fetch).mockImplementation(async (_url, init) =>
        init?.method === "PATCH"
            ? Response.json(
                  {
                      code: "RESTRICTED_FOLDER_REQUEST_NOT_PENDING",
                      error: "conflict",
                  },
                  { status: 409 },
              )
            : Response.json({ invitations: mocks.invitations }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
        expect(screen.queryByRole("link", { name: "Acme" })).toBeNull(),
    );
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
});

it("updates the waiting notice to the remaining request after another is resolved", async () => {
    show("pending", true, true, false);
    const pending = mocks.invitations[0];
    if (pending.kind !== "folder-access")
        throw new Error("Expected an access request");
    const remaining = {
        ...pending,
        id: "remaining",
        title: "Other project",
        folderName: "Other project",
    };
    mocks.invitations = [remaining, pending];
    await act(async () => mocks.onEvent({ type: "share" }));
    await waitFor(() => expect(toast.custom).toHaveBeenCalledTimes(2));
    mocks.invitations = [remaining];
    await act(async () => mocks.onEvent({ type: "share" }));
    await waitFor(() => expect(toast.custom).toHaveBeenCalledTimes(3));
    const notice = vi.mocked(toast.custom).mock.calls.at(-1)?.[0];
    render(notice?.("new-item"));
    expect(screen.getByText("Other project")).toBeTruthy();
    expect(screen.queryByText("Acme")).toBeNull();
});

it("ignores an older pending reload after a newer share reload clears the request", async () => {
    show("pending", true, true, false);
    const pending = mocks.invitations;
    let finish: (response: Response) => void = () => {};
    vi.mocked(fetch).mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    act(() => mocks.onEvent({ type: "share" }));
    mocks.invitations = [];
    await act(async () => mocks.onEvent({ type: "share" }));
    await waitFor(() =>
        expect(
            screen.queryByRole("button", { name: "Invitations (1)" }),
        ).toBeNull(),
    );
    await act(async () => finish(Response.json({ invitations: pending })));
    expect(
        screen.queryByRole("button", { name: "Invitations (1)" }),
    ).toBeNull();
    expect(toast.custom).toHaveBeenCalledOnce();
    expect(toast.dismiss).toHaveBeenCalledWith("new-item");
});

it("does not restore an approved request when the notice-opening reload finishes later", async () => {
    show("pending", true, true, false);
    const pending = mocks.invitations;
    let finish: (response: Response) => void = () => {};
    vi.mocked(fetch).mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    const notice = vi.mocked(toast.custom).mock.calls.at(-1)?.[0];
    expect(notice).toBeDefined();
    render(notice?.("new-item"));
    fireEvent.click(screen.getByRole("button", { name: 'Open "Acme"' }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    await act(async () => finish(Response.json({ invitations: pending })));
    expect(screen.queryByRole("link", { name: "Acme" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
});
