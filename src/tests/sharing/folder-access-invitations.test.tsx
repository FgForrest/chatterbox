// @vitest-environment jsdom
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import type { TranslationValues } from "use-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
    type Invitation,
    PersonInvitations,
    PersonSharingProvider,
} from "@/components/sharing/person-sharing";
import { translatedSourceMessage } from "@/lib/i18n/messages";

const mocks = vi.hoisted(() => ({
    locale: "en" as "en" | "cs-CZ",
    refresh: vi.fn(),
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
vi.mock("@/lib/events/client", () => ({ subscribeEvents: () => () => {} }));
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
    mocks.locale = "en";
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ updated: true })),
    );
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});
function show(state: "pending" | "approved" | "declined" = "pending") {
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
    render(
        <PersonSharingProvider value>
            <PersonInvitations
                notifications={false}
                folders={[]}
                initialInvitations={[invitation]}
            />
        </PersonSharingProvider>,
    );
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
