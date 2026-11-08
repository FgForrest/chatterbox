// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TranslationValues } from "use-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
    PersonInvitations,
    PersonSharingProvider,
    ReceivedItemBanner,
} from "@/components/sharing/person-sharing";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import type { RecordingFolder } from "@/types/folder";

const mocks = vi.hoisted(() => ({ locale: "en" as "en" | "cs-CZ" }));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
    usePathname: () => "/dashboard",
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-intl", () => ({
    useExtracted: () => translate,
    useLocale: () => mocks.locale,
    useFormatter: () => ({
        dateTime: () => "8 November",
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

const READ_ONLY =
    "The agenda is recorded. Its points and notes are read-only. Recordings and their tasks keep their own sharing.";
const CO_EDIT =
    "You can co-edit the agenda. Recordings and their tasks keep their own sharing.";
const folder: RecordingFolder = {
    id: "cedar",
    name: "Cedar",
    parentId: null,
    kind: "custom",
    scope: "personal",
    sortOrder: 0,
    version: 0,
};

beforeEach(() => {
    mocks.locale = "en";
    window.localStorage.clear();
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ invitations: [] })),
    );
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function invitations(recorded: boolean) {
    render(
        <PersonSharingProvider value>
            <PersonInvitations
                notifications={false}
                folders={[folder]}
                initialInvitations={[
                    {
                        id: "plan",
                        itemId: "meeting",
                        kind: "meeting",
                        title: "Quarterly plan",
                        ownerName: "Jitka Dvořáková",
                        ownerEmail: "jitka@example.com",
                        invitedAt: new Date("2026-11-08T10:00:00Z"),
                        version: 0,
                        visibleInFolders: [],
                        recorded,
                    },
                ]}
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
] as const)("describes a recorded agenda invitation as read-only in the card and the acceptance dialog in %s", async (locale) => {
    mocks.locale = locale;
    invitations(true);
    expect(screen.getByText(translate(READ_ONLY))).toBeTruthy();
    expect(screen.queryByText(translate(CO_EDIT))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: translate("Accept…") }));
    expect(
        await screen.findByRole("dialog", { name: translate("Accept agenda") }),
    ).toBeTruthy();
    expect(screen.getByText(translate(READ_ONLY))).toBeTruthy();
    expect(screen.queryByText(translate(CO_EDIT))).toBeNull();
});

it("keeps the co-edit copy for an agenda invitation that is not recorded", async () => {
    invitations(false);
    expect(screen.getByText(CO_EDIT)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Accept…" }));
    expect(
        await screen.findByRole("dialog", { name: "Accept agenda" }),
    ).toBeTruthy();
    expect(screen.getByText(CO_EDIT)).toBeTruthy();
    expect(screen.queryByText(READ_ONLY)).toBeNull();
});

it("describes a recorded received agenda as read-only when filing it", async () => {
    render(
        <ReceivedItemBanner
            recording={{
                id: "meeting",
                kind: "meeting",
                filename: "Quarterly plan",
                ownerName: "Jitka Dvořáková",
                receivedFolderIds: [],
                receivedShare: {
                    id: "share",
                    version: 1,
                    filingFolderId: null,
                },
            }}
            folders={[folder]}
            readOnly
        />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose a folder" }));
    expect(
        await screen.findByRole("dialog", { name: "File agenda" }),
    ).toBeTruthy();
    expect(screen.getByText(READ_ONLY)).toBeTruthy();
    expect(screen.queryByText(CO_EDIT)).toBeNull();
});
