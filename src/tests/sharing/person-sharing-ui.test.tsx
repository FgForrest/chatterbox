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
import { ItemHeader } from "@/components/items/item-header";
import {
    PersonInvitations,
    PersonShareDialog,
    PersonSharingProvider,
    ReceivedItemBanner,
} from "@/components/sharing/person-sharing";
import { TaskRow } from "@/components/tasks/task-row";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import { subscribeEvents } from "@/lib/events/client";
import type { TaskView } from "@/lib/tasks/tasks";
import type { Recording } from "@/types/recording";
import csMessages from "../../../messages/cs-CZ.json";
import enMessages from "../../../messages/en.json";

const { refresh, notices, locale } = vi.hoisted(() => ({
    locale: { current: "en" },
    refresh: vi.fn(),
    notices: vi.fn(),
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh }),
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-intl", () => {
    const translate = (
        text: string,
        values?: Record<string, string | number>,
    ) =>
        (locale.current === "cs-CZ" && text === "Could not update sharing"
            ? csMessages.s3TU5k
            : text
        )
            .replace(
                /\{count, plural, one \{([^}]+)\} other \{([^}]+)\}\}/g,
                (_match, one: string, other: string) =>
                    (Number(values?.count) === 1 ? one : other).replaceAll(
                        "#",
                        String(values?.count),
                    ),
            )
            .replace(/\{(\w+)\}/g, (match, key: string) =>
                values?.[key] === undefined ? match : String(values[key]),
            );
    return {
        useExtracted: () => translate,
        useLocale: () => "en",
        useFormatter: () => ({ dateTime: () => "2026-10-22" }),
    };
});
vi.mock("sonner", () => ({
    toast: {
        custom: notices,
        dismiss: vi.fn(),
        error: vi.fn(),
        success: vi.fn(),
    },
}));
vi.mock("@/lib/events/client", () => ({
    subscribeEvents: vi.fn(() => () => {}),
}));
vi.mock("@/components/recordings/ai-cost-summary", () => ({
    AiCostSummary: () => <span>AI cost</span>,
}));
vi.mock("@/components/recordings/folder-picker", () => ({
    FolderPicker: ({
        open,
        title,
        scope,
        onSelect,
    }: {
        open: boolean;
        title?: string;
        scope: string;
        onSelect: (id: string) => Promise<void>;
    }) =>
        open ? (
            <div role="dialog" aria-label={title}>
                <span>{scope}</span>
                <button
                    type="button"
                    onClick={() => void onSelect("my-folder")}
                >
                    My private folder
                </button>
            </div>
        ) : null,
}));

const share = (
    state: "pending" | "accepted" | "declined" | "removed",
    index = 0,
) => ({
    id: `share-${index}`,
    receiverUserId: `receiver-${index}`,
    name: ["Lena Fischer", "Priya Raman", "Alex Morgan", "Sam Okafor"][index],
    email: `person${index}@example.com`,
    state,
    version: 0,
    invitedAt: new Date(),
    respondedAt: null,
});
const item: Recording = {
    id: "audio",
    filename: "Interview",
    duration: 1000,
    filesize: 100,
    startTime: "2026-10-22T10:00:00Z",
    deviceSn: "local",
    view: "received",
    isOwn: false,
    ownerName: "Alex Morgan",
    receivedShare: { id: "share", version: 2, filingFolderId: "my-folder" },
};
let shares: ReturnType<typeof share>[] = [];
let requests: ReturnType<typeof vi.fn>;

beforeEach(() => {
    locale.current = "en";
    shares = [];
    requests = vi.fn(async (input: string, init?: RequestInit) => {
        if (init?.method === "PATCH") return Response.json({ success: true });
        if (input.startsWith("/api/items/")) return Response.json({ shares });
        if (input.startsWith("/api/shares/people"))
            return Response.json({ people: [] });
        return Response.json({ invitations: [] });
    });
    vi.stubGlobal("fetch", requests);
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

function header(enabled = true, received = false, shared = false) {
    return render(
        <PersonSharingProvider value={enabled}>
            <TooltipProvider>
                <ItemHeader
                    itemId="audio"
                    kind="audio"
                    title="Interview"
                    metadata={["1 minute"]}
                    view={received ? "received" : "private"}
                    isOwn={!received}
                    shared={shared}
                    ownerName="Alex Morgan"
                />
            </TooltipProvider>
        </PersonSharingProvider>,
    );
}

describe("person sharing controls", () => {
    it("announces a live invitation with the existing corner notice", async () => {
        render(
            <PersonSharingProvider value>
                <PersonInvitations initialInvitations={[]} folders={[]} />
            </PersonSharingProvider>,
        );
        requests.mockResolvedValueOnce(
            Response.json({
                invitations: [
                    {
                        id: "live",
                        itemId: "audio",
                        kind: "audio",
                        title: "Interview",
                        ownerName: "Alex Morgan",
                        ownerEmail: "alex@example.com",
                        invitedAt: "2026-10-22T10:00:00Z",
                        version: 0,
                    },
                ],
            }),
        );
        await act(async () => {
            vi.mocked(subscribeEvents).mock.calls[0][0]({ type: "share" });
        });
        expect(
            screen.getByRole("button", { name: "Invitations (1)" }),
        ).toBeTruthy();
        expect(notices).toHaveBeenCalledOnce();
        const notice = render(notices.mock.calls[0][0]());
        expect(
            screen.getByText("Alex Morgan shared an item with you"),
        ).toBeTruthy();
        expect(
            notice.container.querySelector(".text-person-share"),
        ).toBeTruthy();
        fireEvent.click(
            screen.getByRole("button", { name: 'Open "Interview"' }),
        );
        expect(
            await screen.findByRole("button", { name: "Accept and file…" }),
        ).toBeTruthy();
    });

    it("lists every owner state and its action", async () => {
        shares = [
            share("pending"),
            share("accepted", 1),
            share("declined", 2),
            share("removed", 3),
        ];
        render(
            <PersonShareDialog
                itemId="audio"
                kind="audio"
                title="Interview"
                open
                onOpenChange={vi.fn()}
            />,
        );
        expect(await screen.findByText("Waiting for acceptance")).toBeTruthy();
        for (const state of ["Accepted", "Declined", "Removed"])
            expect(screen.getByText(state)).toBeTruthy();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
        expect(
            screen.getAllByRole("button", { name: "Invite again" }),
        ).toHaveLength(2);
        expect(
            screen.getByText("Everyone must accept their invitation."),
        ).toBeTruthy();
    });

    it("explains a link with no recipients before copying", async () => {
        header();
        fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
        expect(
            await screen.findByText("Only you can open this link"),
        ).toBeTruthy();
        expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Copy anyway" }));
        await waitFor(() =>
            expect(navigator.clipboard.writeText).toHaveBeenCalledOnce(),
        );
    });

    it("keeps inactive sharing history manageable after Organization publication", async () => {
        shares = [share("declined"), share("removed", 1)];
        header(true, false, true);
        fireEvent.click(
            await screen.findByRole("button", { name: "Manage sharing" }),
        );
        expect(await screen.findByText("Declined")).toBeTruthy();
        expect(screen.getByText("Removed")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Invite again" }),
        ).toBeNull();
        expect(screen.queryByRole("textbox")).toBeNull();
    });

    it("uses singular recipient counts for one colleague", async () => {
        shares = [share("accepted")];
        header();
        expect(await screen.findByText("Shared with 1 person")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
        expect(
            await screen.findByText("Only you and 1 person can open this link"),
        ).toBeTruthy();
    });

    it("names accepted and pending recipients and exposes header metadata", async () => {
        shares = [share("accepted"), share("pending", 1)];
        header();
        const marker = await screen.findByText("Shared with 2 people");
        expect(marker.closest('[data-slot="item-metadata"]')).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
        expect(
            await screen.findByText("Only you and 2 people can open this link"),
        ).toBeTruthy();
        expect(screen.getByText("Lena Fischer")).toBeTruthy();
        expect(
            screen.getByText("Priya Raman (Waiting for acceptance)"),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Manage sharing" }),
        ).toBeTruthy();
    });

    it("shows the invitation count and accepts into the personal folder picker", async () => {
        render(
            <PersonSharingProvider value>
                <PersonInvitations
                    initialInvitations={[
                        {
                            id: "invite",
                            itemId: "audio",
                            kind: "audio",
                            title: "Interview",
                            ownerName: "Alex Morgan",
                            ownerEmail: "alex@example.com",
                            invitedAt: new Date(),
                            version: 0,
                        },
                    ]}
                    folders={[]}
                />
            </PersonSharingProvider>,
        );
        expect(
            screen.getByRole("button", { name: "Invitations (1)" }),
        ).toBeTruthy();
        fireEvent.click(
            screen.getByRole("button", { name: "Invitations (1)" }),
        );
        fireEvent.click(
            await screen.findByRole("button", { name: "Accept and file…" }),
        );
        expect(
            screen.getByRole("dialog", {
                name: "Where should this recording go?",
            }),
        ).toBeTruthy();
        expect(screen.getByText("personal")).toBeTruthy();
        await act(async () =>
            fireEvent.click(
                screen.getByRole("button", { name: "My private folder" }),
            ),
        );
        expect(requests).toHaveBeenCalledWith(
            "/api/shares/invite",
            expect.objectContaining({
                method: "PATCH",
                body: JSON.stringify({
                    action: "accept",
                    version: 0,
                    folderId: "my-folder",
                }),
            }),
        );
        await waitFor(() =>
            expect(
                screen.queryByRole("button", { name: "Accept and file…" }),
            ).toBeNull(),
        );
    });

    it("hides owner controls and private folder context from a receiver", () => {
        const { container } = header(true, true);
        render(<ReceivedItemBanner recording={item} folders={[]} />);
        expect(screen.getByText("Shared with you by Alex Morgan")).toBeTruthy();
        expect(
            screen.getByText(/Private recording from Alex Morgan/),
        ).toBeTruthy();
        expect(container.querySelector("header")?.className).toContain(
            "border-person-share",
        );
        for (const name of [
            "Share",
            "Rename Interview",
            "Regenerate title for Interview",
        ])
            expect(screen.queryByRole("button", { name })).toBeNull();
        expect(screen.queryByText("AI cost")).toBeNull();
    });

    it("adds no sharing UI when disabled", () => {
        header(false);
        expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
        expect(requests).not.toHaveBeenCalled();
    });

    it.each([
        true,
        false,
    ])("keeps receiver note and follow controls with assigned=%s while hiding content actions", async (assigned) => {
        const task: TaskView = {
            id: "task",
            recordingId: "audio",
            evidenceItemId: "audio",
            evidenceItemKind: "audio",
            evidenceAudioAvailable: true,
            text: "Send the plan",
            status: "open",
            assignee: { personId: "", name: "Lena Fischer" },
            assigneeHasEmail: true,
            assigneeHint: null,
            assigneeCheck: false,
            dueDate: null,
            duePhrase: null,
            quote: null,
            evidenceStartMs: null,
            evidenceText: null,
            evidenceProvenance: null,
            source: "manual",
            ticked: true,
            version: 0,
            createdAt: "2026-10-22T10:00:00Z",
            acceptedAt: null,
            statusChangedAt: null,
            canEdit: false,
            canClose: assigned,
            canUndoMatch: false,
            own: false,
            note: null,
            noteUpdatedAt: null,
            noteBy: null,
            following: false,
            automaticFollow: false,
            canFollow: true,
            canMerge: false,
            receivedOwnerName: "Alex Morgan",
        };
        const change = vi.fn();
        render(
            <TaskRow task={task} organizationOnly={false} onChange={change} />,
        );
        expect(screen.queryByRole("textbox")).toBeNull();
        expect(screen.queryByRole("button", { name: "Drop" })).toBeNull();
        expect(screen.queryByRole("button", { name: /Merge/ })).toBeNull();
        expect(
            screen.getByText("Only Alex Morgan can edit this task."),
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Follow" }));
        await waitFor(() =>
            expect(requests).toHaveBeenCalledWith(
                "/api/tasks/task/follow",
                expect.objectContaining({ method: "POST" }),
            ),
        );
        fireEvent.click(screen.getByRole("checkbox"));
        if (assigned) {
            expect(change).toHaveBeenCalledWith(
                { status: "done" },
                { status: "done" },
            );
            expect(screen.getByRole("textbox", { name: "Note" })).toBeTruthy();
            fireEvent.change(screen.getByRole("textbox", { name: "Note" }), {
                target: { value: "Receiver outcome" },
            });
            fireEvent.click(screen.getByRole("button", { name: "Save note" }));
            expect(change).toHaveBeenCalledWith(
                { note: "Receiver outcome" },
                { note: "Receiver outcome" },
            );
        } else {
            expect(change).not.toHaveBeenCalled();
            expect(screen.queryByRole("button", { name: "Note" })).toBeNull();
            expect(screen.queryByRole("textbox")).toBeNull();
        }
    });
    it.each([
        "http",
        "network",
        "stale",
    ])("keeps link access neutral after a %s load failure", async (failure) => {
        if (failure === "stale") {
            shares = [share("accepted")];
            header();
            await screen.findByText("Shared with 1 person");
        } else {
            requests.mockImplementation(async () => {
                if (failure === "network")
                    throw new TypeError("Network failure");
                return Response.json({}, { status: 429 });
            });
            header();
        }
        if (failure === "stale")
            requests.mockResolvedValue(Response.json({}, { status: 429 }));
        fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
        expect(
            await screen.findByRole("dialog", { name: "Link access" }),
        ).toBeTruthy();
        expect(
            await screen.findByText(
                "This is a private link. Access depends on the item’s sharing settings.",
            ),
        ).toBeTruthy();
        expect(screen.queryByText("Only you can open this link")).toBeNull();
        expect(screen.queryByText(/Only you and/)).toBeNull();
        expect(
            screen.queryByText(
                "Share the item first so a colleague can open the link.",
            ),
        ).toBeNull();
        fireEvent.click(
            within(
                screen.getByRole("dialog", { name: "Link access" }),
            ).getByRole("button", { name: "Copy link" }),
        );
        await waitFor(() =>
            expect(navigator.clipboard.writeText).toHaveBeenCalledOnce(),
        );
    });

    it.each([
        "empty",
        "missing",
        "invalid",
    ])("uses the extracted Czech fallback for a sharing response with an %s message", async (body) => {
        locale.current = "cs-CZ";
        shares = [share("accepted")];
        requests.mockImplementation(
            async (_input: string, init?: RequestInit) =>
                init?.method === "PATCH"
                    ? Response.json(
                          body === "empty"
                              ? { error: "", code: "INTERNAL_ERROR" }
                              : body === "missing"
                                ? {}
                                : { error: 123 },
                          { status: 500 },
                      )
                    : Response.json({ shares }),
        );
        render(
            <PersonShareDialog
                itemId="audio"
                kind="audio"
                title="Interview"
                open
                onOpenChange={vi.fn()}
            />,
        );
        fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
        expect(await screen.findByRole("alert")).toHaveProperty(
            "textContent",
            "Sdílení se nepodařilo změnit",
        );
    });
    it("uses the caller's accessible title for a reusable popover", () => {
        render(
            <Popover open>
                <PopoverContent title="Sharing controls">
                    Details
                </PopoverContent>
            </Popover>,
        );
        expect(
            screen.getByRole("dialog", { name: "Sharing controls" }),
        ).toBeTruthy();
        expect(screen.queryByText("Link access")).toBeNull();
    });

    it("uses standard Czech invitation labels without changing the English source", () => {
        expect(csMessages.HyiDcy).toBe("K přijetí");
        expect(csMessages.eCzP2A).toBe("K přijetí ({count})");
        expect(enMessages.HyiDcy).toBe("Invitations");
        expect(enMessages.eCzP2A).toBe("Invitations ({count})");
    });
});
