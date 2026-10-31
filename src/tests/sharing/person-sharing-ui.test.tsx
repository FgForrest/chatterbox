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
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemHeader } from "@/components/items/item-header";
import type { CreatedFolder } from "@/components/pipeline/new-folder-form";
import {
    PersonInvitations,
    PersonShareDialog,
    PersonSharingProvider,
    ReceivedItemBanner,
} from "@/components/sharing/person-sharing";
import { ReceivedItemDialog } from "@/components/sharing/received-item-dialog";
import { TaskRow } from "@/components/tasks/task-row";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import { subscribeEvents } from "@/lib/events/client";
import type { listItemFolderAudience } from "@/lib/sharing/person-shares";
import type { TaskView } from "@/lib/tasks/tasks";
import type { RecordingFolder } from "@/types/folder";
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
        source: string | { message: string },
        values?: Record<string, string | number>,
    ) => {
        const text = typeof source === "string" ? source : source.message;
        return (
            locale.current === "cs-CZ" && text === "Could not update sharing"
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
    };
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
const ownFolder: RecordingFolder = {
    id: "my-folder",
    name: "My private folder",
    parentId: "root",
    kind: "custom",
    scope: "personal",
    version: 0,
    sortOrder: 0,
};
const sharedFolder: RecordingFolder = {
    ...ownFolder,
    id: "attached",
    name: "Local research",
    receivedFolder: {
        shareId: "folder-share",
        shareVersion: 1,
        ownerName: "Alex Morgan",
        originalName: "Research",
    },
};
let folderAudience: Awaited<ReturnType<typeof listItemFolderAudience>> = [];
let shares: ReturnType<typeof share>[] = [];
let requests: ReturnType<typeof vi.fn>;

const invitation = (id: string) => ({
    id,
    itemId: "audio",
    kind: "audio" as const,
    title: "Interview",
    ownerName: "Alex Morgan",
    ownerEmail: "alex@example.com",
    invitedAt: new Date("2026-10-22T10:00:00Z"),
    version: 0,
    visibleInFolders: [],
});

describe.each(["audio", "mail"] as const)("received %s dialog", (kind) => {
    describe.each([
        "ordinary",
        "already-visible",
    ] as const)("%s variant", (variant) => {
        it("uses the shared body and returns without accepting", () => {
            const save = vi.fn();
            const close = vi.fn();
            render(
                <ReceivedItemDialog
                    item={{
                        ...invitation("dialog"),
                        kind,
                        visibleInFolders:
                            variant === "ordinary"
                                ? []
                                : [
                                      {
                                          id: sharedFolder.id,
                                          name: sharedFolder.name,
                                      },
                                  ],
                    }}
                    folders={[ownFolder, sharedFolder]}
                    open
                    onOpenChange={close}
                    onSave={save}
                />,
            );
            expect(
                screen.getByRole("dialog", {
                    name: kind === "mail" ? "Accept email" : "Accept recording",
                }),
            ).toBeTruthy();
            expect(
                Boolean(screen.queryByRole("radio", { name: /Only in/ })),
            ).toBe(variant === "already-visible");
            fireEvent.click(screen.getByRole("button", { name: "Back" }));
            expect(close).toHaveBeenCalledWith(false);
            expect(save).not.toHaveBeenCalled();
        });
    });

    it("creates a private folder and waits for acceptance before filing", async () => {
        const save = vi.fn().mockResolvedValue(undefined);
        render(
            <ReceivedItemDialog
                item={{ ...invitation("dialog"), kind }}
                folders={[ownFolder, sharedFolder]}
                open
                onOpenChange={vi.fn()}
                onSave={save}
            />,
        );
        fireEvent.click(screen.getByRole("option", { name: "New folder…" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), {
            target: { value: "New project" },
        });
        requests.mockResolvedValueOnce(
            Response.json({
                folder: { ...ownFolder, id: "created", name: "New project" },
            }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
        expect(
            await screen.findByText("New project", { selector: "p" }),
        ).toBeTruthy();
        expect(save).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Accept" }));
        await waitFor(() => expect(save).toHaveBeenCalledWith("created"));
        expect(requests).toHaveBeenCalledWith(
            "/api/folders",
            expect.objectContaining({
                body: JSON.stringify({
                    parentId: ownFolder.id,
                    name: "New project",
                }),
            }),
        );
    });
    describe.each(["accept", "file"] as const)("%s", (action) => {
        it("requires an own folder and submits only after confirmation", async () => {
            const save = vi.fn().mockResolvedValue(undefined);
            render(
                <ReceivedItemDialog
                    item={{ ...invitation("dialog"), kind }}
                    folders={[ownFolder, sharedFolder]}
                    action={action}
                    open
                    onOpenChange={vi.fn()}
                    onSave={save}
                />,
            );
            const submit = screen.getByRole("button", {
                name: action === "accept" ? "Accept" : "Save",
            });
            expect(submit).toHaveProperty("disabled", true);
            expect(
                screen.getByText(
                    kind === "mail"
                        ? "You can read the email and summary."
                        : "You can read the transcript and summary.",
                ),
            ).toBeTruthy();
            expect(
                screen.getByText("You can complete tasks assigned to you."),
            ).toBeTruthy();
            expect(
                screen.getByText(
                    "It stays private. The Organization does not see it.",
                ),
            ).toBeTruthy();
            expect(
                screen.queryByRole("option", { name: sharedFolder.name }),
            ).toBeNull();
            expect(
                screen.getByRole("option", { name: "New folder…" }),
            ).toBeTruthy();
            fireEvent.click(
                screen.getByRole("option", { name: ownFolder.name }),
            );
            expect(save).not.toHaveBeenCalled();
            fireEvent.click(submit);
            await waitFor(() =>
                expect(save).toHaveBeenCalledWith(ownFolder.id),
            );
        });

        it("defaults to the existing path and can explicitly add another filing", async () => {
            const save = vi.fn().mockResolvedValue(undefined);
            const dialog = render(
                <ReceivedItemDialog
                    item={{
                        ...invitation("dialog"),
                        kind,
                        visibleInFolders: [
                            { id: sharedFolder.id, name: sharedFolder.name },
                        ],
                    }}
                    folders={[ownFolder, sharedFolder]}
                    action={action}
                    open
                    onOpenChange={vi.fn()}
                    onSave={save}
                />,
            );
            expect(
                screen.getByText(
                    "You already see it in Local research, a folder Alex Morgan shares with you.",
                ),
            ).toBeTruthy();
            expect(
                screen.getByRole("radio", { name: /Only in Local research/ }),
            ).toHaveProperty("checked", true);
            expect(screen.queryByRole("combobox")).toBeNull();
            expect(
                screen.queryByText(
                    "Accepting keeps it for you even if Alex Morgan takes it out of Local research.",
                ) !== null,
            ).toBe(action === "accept");
            fireEvent.click(
                screen.getByRole("button", {
                    name: action === "accept" ? "Accept" : "Save",
                }),
            );
            await waitFor(() => expect(save).toHaveBeenCalledWith(undefined));
            dialog.unmount();
            save.mockClear();
            render(
                <ReceivedItemDialog
                    item={{
                        ...invitation("dialog"),
                        kind,
                        visibleInFolders: [
                            { id: sharedFolder.id, name: sharedFolder.name },
                        ],
                    }}
                    folders={[ownFolder, sharedFolder]}
                    action={action}
                    open
                    onOpenChange={vi.fn()}
                    onSave={save}
                />,
            );
            fireEvent.click(
                screen.getByRole("radio", { name: /Also in another folder/ }),
            );
            expect(
                screen.getByRole("button", {
                    name: action === "accept" ? "Accept" : "Save",
                }),
            ).toHaveProperty("disabled", true);
            fireEvent.click(
                screen.getByRole("option", { name: ownFolder.name }),
            );
            fireEvent.click(
                screen.getByRole("button", {
                    name: action === "accept" ? "Accept" : "Save",
                }),
            );
            await waitFor(() =>
                expect(save).toHaveBeenCalledWith(ownFolder.id),
            );
        });

        it("keeps a refused folder-free mutation visible for retry", async () => {
            const close = vi.fn();
            render(
                <ReceivedItemDialog
                    item={{
                        ...invitation("dialog"),
                        kind,
                        visibleInFolders: [
                            { id: sharedFolder.id, name: sharedFolder.name },
                        ],
                    }}
                    folders={[ownFolder, sharedFolder]}
                    action={action}
                    open
                    onOpenChange={close}
                    onSave={vi
                        .fn()
                        .mockRejectedValue(
                            new Error("Choose a private folder"),
                        )}
                />,
            );
            fireEvent.click(
                screen.getByRole("button", {
                    name: action === "accept" ? "Accept" : "Save",
                }),
            );
            expect(await screen.findByRole("alert")).toHaveProperty(
                "textContent",
                "Choose a private folder",
            );
            expect(close).not.toHaveBeenCalled();
            fireEvent.click(
                screen.getByRole("radio", { name: /Also in another folder/ }),
            );
            expect(
                screen.getByRole("option", { name: ownFolder.name }),
            ).toBeTruthy();
        });
    });
});

function invitations(initial: ReturnType<typeof invitation>[]) {
    return render(
        <PersonSharingProvider value>
            <PersonInvitations initialInvitations={initial} folders={[]} />
        </PersonSharingProvider>,
    );
}

beforeEach(() => {
    window.localStorage.clear();
    locale.current = "en";
    shares = [];
    folderAudience = [];
    Element.prototype.scrollIntoView = vi.fn();
    requests = vi.fn(async (input: string, init?: RequestInit) => {
        if (init?.method === "PATCH") return Response.json({ success: true });
        if (input.startsWith("/api/items/"))
            return Response.json({ shares, folderAudience });
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
    describe.each([
        "audio",
        "mail",
        "folder",
    ] as const)("%s acceptance", (kind) => {
        it.each([
            "back",
            "escape",
        ])("returns to pending invitations on %s", (dismissal) => {
            render(
                <PersonSharingProvider value>
                    <PersonInvitations
                        initialInvitations={[
                            { ...invitation("waiting"), kind },
                        ]}
                        folders={[ownFolder]}
                        notifications={false}
                    />
                </PersonSharingProvider>,
            );
            fireEvent.click(
                screen.getByRole("button", { name: "Invitations (1)" }),
            );
            fireEvent.click(screen.getByRole("button", { name: "Accept…" }));
            if (dismissal === "escape")
                fireEvent.keyDown(screen.getByRole("dialog"), {
                    key: "Escape",
                });
            else
                fireEvent.click(
                    screen.getByRole("button", {
                        name: kind === "folder" ? "Cancel" : "Back",
                    }),
                );
            expect(
                screen.getByRole("dialog", { name: /Invitations/ }),
            ).toBeTruthy();
            expect(requests).not.toHaveBeenCalled();
        });

        it.each([
            1, 2,
        ])("stays closed after accepting with %s invitation(s) pending", async (count) => {
            render(
                <PersonSharingProvider value>
                    <PersonInvitations
                        initialInvitations={Array.from(
                            { length: count },
                            (_, index) => ({
                                ...invitation(`waiting-${index}`),
                                kind,
                            }),
                        )}
                        folders={[ownFolder]}
                        notifications={false}
                    />
                </PersonSharingProvider>,
            );
            fireEvent.click(
                screen.getByRole("button", { name: `Invitations (${count})` }),
            );
            fireEvent.click(
                screen.getAllByRole("button", { name: "Accept…" })[0],
            );
            if (kind !== "folder")
                fireEvent.click(
                    screen.getByRole("option", { name: ownFolder.name }),
                );
            await act(async () => {
                fireEvent.click(
                    screen.getByRole("button", {
                        name: kind === "folder" ? "Attach" : "Accept",
                    }),
                );
            });
            expect(requests).toHaveBeenCalledWith(
                kind === "folder"
                    ? "/api/folder-shares/waiting-0"
                    : "/api/shares/waiting-0",
                expect.objectContaining({ method: "PATCH" }),
            );
            expect(screen.queryByRole("dialog")).toBeNull();
            if (count === 1)
                expect(
                    screen.queryByRole("button", { name: /Invitations/ }),
                ).toBeNull();
            else {
                fireEvent.click(
                    screen.getByRole("button", { name: "Invitations (1)" }),
                );
                expect(screen.getAllByRole("article")).toHaveLength(1);
            }
        });
    });

    describe.each(["audio", "mail"] as const)("%s folder creation", (kind) => {
        it.each([
            "invitation",
            "banner",
        ] as const)("retains a created folder after returning from the %s dialog", async (surface) => {
            const created = {
                ...ownFolder,
                id: "created",
                name: "New project",
            };
            const onFolderCreated = vi.fn();
            const initial = [{ ...invitation("waiting"), kind }];
            function Parent() {
                const [folders, setFolders] = useState([ownFolder]);
                const handleCreated = (folder: CreatedFolder) => {
                    onFolderCreated(folder);
                    setFolders((current) => [...current, folder]);
                };
                return (
                    <PersonSharingProvider value>
                        {surface === "invitation" ? (
                            <PersonInvitations
                                initialInvitations={initial}
                                folders={folders}
                                onFolderCreated={handleCreated}
                                notifications={false}
                            />
                        ) : (
                            <ReceivedItemBanner
                                recording={{ ...item, kind }}
                                folders={folders}
                                onFolderCreated={handleCreated}
                            />
                        )}
                    </PersonSharingProvider>
                );
            }
            render(<Parent />);
            const openDialog = () => {
                if (surface === "invitation") {
                    fireEvent.click(
                        screen.getByRole("button", { name: "Invitations (1)" }),
                    );
                    fireEvent.click(
                        screen.getByRole("button", { name: "Accept…" }),
                    );
                } else
                    fireEvent.click(
                        screen.getByRole("button", { name: ownFolder.name }),
                    );
            };
            openDialog();
            fireEvent.click(
                screen.getByRole("option", { name: "New folder…" }),
            );
            fireEvent.change(
                screen.getByRole("textbox", { name: "Folder name" }),
                { target: { value: created.name } },
            );
            requests.mockResolvedValueOnce(Response.json({ folder: created }));
            fireEvent.click(
                screen.getByRole("button", { name: "Create folder" }),
            );
            await waitFor(() =>
                expect(onFolderCreated).toHaveBeenCalledExactlyOnceWith(
                    created,
                ),
            );
            expect(
                screen.getAllByRole("option", { name: created.name }),
            ).toHaveLength(1);
            fireEvent.click(screen.getByRole("button", { name: "Back" }));
            if (surface === "invitation")
                fireEvent.click(screen.getByRole("button", { name: "Close" }));
            openDialog();
            expect(
                screen.getByRole("option", { name: created.name }),
            ).toBeTruthy();
        });
    });

    it.each([
        "folder",
        "audio",
        "mail",
    ] as const)("explains the %s invitation card", async (kind) => {
        render(
            <PersonSharingProvider value>
                <PersonInvitations
                    folders={[ownFolder]}
                    notifications={false}
                    initialInvitations={[{ ...invitation("card"), kind }]}
                />
            </PersonSharingProvider>,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Invitations (1)" }),
        );
        const card = screen.getByRole("article");
        expect(
            within(card).getByText(
                kind === "folder"
                    ? "Folder"
                    : kind === "mail"
                      ? "Email"
                      : "Recording",
            ),
        ).toBeTruthy();
        expect(
            within(card).getByText(/Shared by Alex Morgan/).textContent,
        ).toContain("2026-10-22");
        expect(
            within(card).getByText(
                kind === "folder"
                    ? /It becomes a new folder/
                    : kind === "mail"
                      ? /You can read the email and summary/
                      : /You can read the transcript and summary/,
            ),
        ).toBeTruthy();
        expect(
            within(card).getByRole("button", { name: "Accept…" }),
        ).toBeTruthy();
        fireEvent.click(within(card).getByRole("button", { name: "Decline" }));
        await waitFor(() =>
            expect(requests).toHaveBeenCalledWith(
                kind === "folder"
                    ? "/api/folder-shares/card"
                    : "/api/shares/card",
                expect.objectContaining({
                    body: JSON.stringify({ action: "decline", version: 0 }),
                }),
            ),
        );
    });

    it.each([
        "audio",
        "mail",
    ] as const)("accepts an already visible %s in one click without auto-accepting", async (kind) => {
        render(
            <PersonSharingProvider value>
                <PersonInvitations
                    folders={[sharedFolder]}
                    notifications={false}
                    initialInvitations={[
                        {
                            ...invitation("overlap"),
                            kind,
                            visibleInFolders: [
                                {
                                    id: sharedFolder.id,
                                    name: sharedFolder.name,
                                },
                            ],
                        },
                    ]}
                />
            </PersonSharingProvider>,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Invitations (1)" }),
        );
        expect(screen.getByText("Already in your folder")).toBeTruthy();
        expect(screen.getByText("Local research").className).toContain(
            "text-person-share",
        );
        expect(requests).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Accept" }));
        await waitFor(() =>
            expect(requests).toHaveBeenCalledWith(
                "/api/shares/overlap",
                expect.objectContaining({
                    body: JSON.stringify({ action: "accept", version: 0 }),
                }),
            ),
        );
        expect(
            screen.queryByRole("dialog", {
                name: /Accept recording|Accept email/,
            }),
        ).toBeNull();
    });

    it("opens the extra-filing choice from an already visible invitation", () => {
        render(
            <PersonSharingProvider value>
                <PersonInvitations
                    folders={[ownFolder, sharedFolder]}
                    notifications={false}
                    initialInvitations={[
                        {
                            ...invitation("overlap"),
                            visibleInFolders: [
                                {
                                    id: sharedFolder.id,
                                    name: sharedFolder.name,
                                },
                            ],
                        },
                    ]}
                />
            </PersonSharingProvider>,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Invitations (1)" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "File elsewhere too…" }),
        );
        expect(
            screen.getByRole("radio", { name: /Also in another folder/ }),
        ).toHaveProperty("checked", true);
        expect(
            screen.getByRole("option", { name: ownFolder.name }),
        ).toBeTruthy();
        expect(screen.getByRole("button", { name: "Accept" })).toHaveProperty(
            "disabled",
            true,
        );
        fireEvent.click(screen.getByRole("button", { name: "Back" }));
        expect(
            screen.getByRole("dialog", { name: /Invitations/ }),
        ).toBeTruthy();
    });

    it("groups folder audiences separately and labels search results instead of inviting them", async () => {
        folderAudience = [
            {
                folderId: "source",
                folderName: "Research",
                canManage: true,
                receiverUserId: "receiver-0",
                name: "Lena Fischer",
                email: "lena@example.com",
                state: "accepted",
            },
            {
                folderId: "foreign",
                folderName: "Local planning",
                canManage: false,
                receiverUserId: "pending",
                name: "Demo Pending",
                email: "pending@example.com",
                state: "pending",
            },
        ];
        shares = [share("accepted")];
        requests.mockImplementation(async (path: string) =>
            path.includes("/people")
                ? Response.json({
                      people: [
                          {
                              id: "receiver-0",
                              name: "Lena Fischer",
                              email: "lena@example.com",
                          },
                          {
                              id: "pending",
                              name: "Demo Pending",
                              email: "pending@example.com",
                          },
                          {
                              id: "new",
                              name: "Demo New",
                              email: "new@example.com",
                          },
                      ],
                  })
                : Response.json({ shares, folderAudience }),
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
        expect(await screen.findByText("Through folder Research")).toBeTruthy();
        expect(screen.getByText("Through folder Local planning")).toBeTruthy();
        expect(screen.getByText("Directly")).toBeTruthy();
        expect(screen.getAllByText("Lena Fischer")).toHaveLength(2);
        expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(
            1,
        );
        expect(
            screen.getAllByRole("button", { name: "Manage folder sharing" }),
        ).toHaveLength(1);
        fireEvent.change(screen.getByRole("textbox"), {
            target: { value: "demo" },
        });
        expect(
            await screen.findByText("Invited to folder Local planning"),
        ).toBeTruthy();
        expect(screen.getAllByRole("button", { name: "Add" })).toHaveLength(1);
        fireEvent.click(
            screen.getByRole("button", { name: "Manage folder sharing" }),
        );
        expect(
            await screen.findByRole("dialog", { name: "Share folder" }),
        ).toBeTruthy();
        expect(requests).toHaveBeenCalledWith("/api/folders/source/shares");
    });

    it("shows accepted folder search labels and distinct link counts across legacy direct and folder paths", async () => {
        folderAudience = [
            {
                folderId: "source",
                folderName: "Research",
                canManage: true,
                receiverUserId: "receiver-0",
                name: "Lena Fischer",
                email: "lena@example.com",
                state: "accepted",
            },
            {
                folderId: "other",
                folderName: "Planning",
                canManage: false,
                receiverUserId: "receiver-0",
                name: "Lena Fischer",
                email: "lena@example.com",
                state: "accepted",
            },
            {
                folderId: "source",
                folderName: "Research",
                canManage: true,
                receiverUserId: "receiver-1",
                name: "Priya Raman",
                email: "priya@example.com",
                state: "pending",
            },
        ];
        shares = [share("pending")];
        header();
        expect(await screen.findByText("Shared with 2 people")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
        const popover = await screen.findByRole("dialog", {
            name: "Link access",
        });
        expect(
            await within(popover).findByText(
                "You and 2 people can open this link",
            ),
        ).toBeTruthy();
        expect(within(popover).getAllByRole("listitem")).toHaveLength(2);
        expect(within(popover).getAllByText("(through Research)")).toHaveLength(
            2,
        );
        expect(
            within(popover).getByText("Lena Fischer").textContent,
        ).not.toContain("Waiting");
        expect(within(popover).getByText(/Priya Raman/).textContent).toContain(
            "Waiting for acceptance",
        );
        fireEvent.click(
            within(popover).getByRole("button", { name: "Copy link" }),
        );
        await waitFor(() =>
            expect(navigator.clipboard.writeText).toHaveBeenCalledOnce(),
        );
    });

    it("replaces Add for an accepted folder recipient without a direct share", async () => {
        folderAudience = [
            {
                folderId: "source",
                folderName: "Research",
                canManage: true,
                receiverUserId: "receiver-0",
                name: "Lena Fischer",
                email: "lena@example.com",
                state: "accepted",
            },
        ];
        requests.mockImplementation(async (path: string) =>
            path.includes("/people")
                ? Response.json({
                      people: [
                          {
                              id: "receiver-0",
                              name: "Lena Fischer",
                              email: "lena@example.com",
                          },
                      ],
                  })
                : Response.json({ shares, folderAudience }),
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
        await screen.findByText("Through folder Research");
        fireEvent.change(screen.getByRole("textbox"), {
            target: { value: "lena" },
        });
        expect(
            await screen.findByText("Already sees it through Research"),
        ).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    });

    it("unfiles an extra filing without ending the direct share", async () => {
        render(
            <ReceivedItemBanner
                recording={{ ...item, receivedFolderIds: [sharedFolder.id] }}
                folders={[ownFolder, sharedFolder]}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", {
                name: "Remove from My private folder",
            }),
        );
        await waitFor(() =>
            expect(requests).toHaveBeenCalledWith(
                "/api/shares/share",
                expect.objectContaining({
                    body: JSON.stringify({ action: "file", version: 2 }),
                }),
            ),
        );
        expect(refresh).toHaveBeenCalled();
    });

    it("uses the shared filing body when an unfiled received item also has a folder path", () => {
        render(
            <ReceivedItemBanner
                recording={{
                    ...item,
                    receivedFolderIds: [sharedFolder.id],
                    receivedShare: {
                        id: "share",
                        version: 2,
                        filingFolderId: null,
                    },
                }}
                folders={[ownFolder, sharedFolder]}
            />,
        );
        expect(
            screen.queryByRole("button", { name: /Remove from/ }),
        ).toBeNull();
        fireEvent.click(
            screen.getByRole("button", { name: "File elsewhere too…" }),
        );
        expect(
            screen.getByRole("dialog", { name: "File recording" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("radio", { name: /Also in another folder/ }),
        ).toHaveProperty("checked", true);
    });
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
            await screen.findByRole("button", { name: "Accept…" }),
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
            await screen.findByText("You and 1 person can open this link"),
        ).toBeTruthy();
    });

    it("names accepted and pending recipients and exposes header metadata", async () => {
        shares = [share("accepted"), share("pending", 1)];
        header();
        const marker = await screen.findByText("Shared with 2 people");
        expect(marker.closest('[data-slot="item-metadata"]')).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
        expect(
            await screen.findByText("You and 2 people can open this link"),
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
                            visibleInFolders: [],
                        },
                    ]}
                    folders={[ownFolder]}
                />
            </PersonSharingProvider>,
        );
        expect(
            screen.getByRole("button", { name: "Invitations (1)" }),
        ).toBeTruthy();
        fireEvent.click(
            screen.getByRole("button", { name: "Invitations (1)" }),
        );
        fireEvent.click(await screen.findByRole("button", { name: "Accept…" }));
        expect(
            screen.getByRole("dialog", {
                name: "Accept recording",
            }),
        ).toBeTruthy();
        expect(
            screen.getByText(
                "Pick one of your folders. Nothing changes for Alex Morgan.",
            ),
        ).toBeTruthy();
        expect(screen.getByRole("button", { name: "Accept" })).toHaveProperty(
            "disabled",
            true,
        );
        await act(async () =>
            fireEvent.click(
                screen.getByRole("option", { name: "My private folder" }),
            ),
        );
        await act(async () =>
            fireEvent.click(screen.getByRole("button", { name: "Accept" })),
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
                screen.queryByRole("button", { name: "Accept…" }),
            ).toBeNull(),
        );
    });

    it("shows no invitations entry while nothing waits and a filled one when something does", () => {
        const empty = invitations([]);
        expect(
            screen.queryByRole("button", { name: /Invitations/ }),
        ).toBeNull();
        empty.unmount();
        invitations([invitation("waiting")]);
        expect(
            screen.getByRole("button", { name: "Invitations (1)" }).className,
        ).toContain("bg-person-share");
    });

    it("announces invitations waiting on arrival once per browser", () => {
        const first = invitations([invitation("waiting")]);
        expect(notices).toHaveBeenCalledOnce();
        const notice = render(notices.mock.calls[0][0]());
        expect(within(notice.container).queryByText(/0:00/)).toBeNull();
        fireEvent.click(
            within(notice.container).getByRole("button", {
                name: "Close notice",
            }),
        );
        first.unmount();
        notice.unmount();
        notices.mockClear();

        const again = invitations([invitation("waiting")]);
        expect(notices).not.toHaveBeenCalled();
        again.unmount();
        invitations([invitation("waiting"), invitation("newer")]);
        expect(notices).toHaveBeenCalledOnce();
    });

    it("polls for invitations while the live connection is down", async () => {
        vi.useFakeTimers();
        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "visible",
        });
        try {
            invitations([]);
            act(() => vi.mocked(subscribeEvents).mock.calls[0][1]?.("error"));
            requests.mockResolvedValueOnce(
                Response.json({ invitations: [invitation("polled")] }),
            );
            await act(async () => {
                await vi.advanceTimersByTimeAsync(60_000);
            });
            expect(requests).toHaveBeenCalledWith("/api/shares");
            expect(
                screen.getByRole("button", { name: "Invitations (1)" }),
            ).toBeTruthy();
            expect(notices).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it("watches for invitations from one instance per page only", async () => {
        render(
            <PersonSharingProvider value>
                <PersonInvitations initialInvitations={[]} folders={[]} />
                <PersonInvitations
                    initialInvitations={[]}
                    folders={[]}
                    notifications={false}
                />
            </PersonSharingProvider>,
        );
        expect(subscribeEvents).toHaveBeenCalledOnce();
        await act(async () => {
            vi.mocked(subscribeEvents).mock.calls[0][0]({ type: "share" });
        });
        expect(
            requests.mock.calls.filter(([url]) => url === "/api/shares"),
        ).toHaveLength(1);
    });

    it("shows Share and Copy link as icon buttons of one size", async () => {
        header();
        const shareButton = screen.getByRole("button", { name: "Share" });
        const copy = screen.getByRole("button", { name: "Copy link" });
        expect(shareButton.textContent).toBe("");
        for (const button of [shareButton, copy])
            expect(button.className).toContain("size-8");
        fireEvent.focus(shareButton);
        expect(
            await screen.findByRole("tooltip", { name: "Share" }),
        ).toBeTruthy();
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
        if (assigned) {
            fireEvent.click(screen.getByRole("checkbox"));
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
            expect(screen.queryByRole("checkbox")).toBeNull();
            const mark = screen.getByRole("img", { name: "Open" });
            fireEvent.pointerMove(mark, { pointerType: "mouse" });
            expect((await screen.findByRole("tooltip")).textContent).toBe(
                "Only Alex Morgan can edit this task.",
            );
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
        expect(screen.queryByText(/You and/)).toBeNull();
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
        expect(csMessages.HyiDcy).toBe("Pozvánky");
        expect(csMessages.eCzP2A).toBe("Pozvánky ({count})");
        expect(enMessages.HyiDcy).toBe("Invitations");
        expect(enMessages.eCzP2A).toBe("Invitations ({count})");
    });
});
