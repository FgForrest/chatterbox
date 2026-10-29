// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    within,
} from "@testing-library/react";
import { useRef, useState } from "react";
import type { TranslationValues } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThingsList } from "@/components/almanac/things-list";
import { ArrivalNotice } from "@/components/dashboard/arrival-notice";
import { FolderTree } from "@/components/dashboard/folder-tree";
import { RecordingListToolbar } from "@/components/dashboard/recording-list-toolbar";
import { RecordingRow } from "@/components/dashboard/recording-row";
import { TranscriptTopicsMenu } from "@/components/dashboard/transcript-topics-menu";
import { ItemHeader } from "@/components/items/item-header";
import { LearnWidget } from "@/components/learn/learn-widget";
import { AgendaBody } from "@/components/meetings/agenda-body";
import { PeopleList } from "@/components/people/people-list";
import { ApiKeysSection } from "@/components/settings/api-keys-section";
import { WebhooksSection } from "@/components/settings/webhooks-section";
import { ProfilesSection } from "@/components/settings-sections/profiles-section";
import {
    OwnerSharingActions,
    PersonSharingProvider,
    ReceivedItemBanner,
} from "@/components/sharing/person-sharing";
import { SummaryRemarksDialog } from "@/components/summary/summary-remarks-dialog";
import { FolderTasksPanel } from "@/components/tasks/folder-tasks-panel";
import { RecordingTasks } from "@/components/tasks/recording-tasks";
import { TaskReviewLink } from "@/components/tasks/task-review-dialog";
import { TaskRow } from "@/components/tasks/task-row";
import type { RecordingTasksState } from "@/components/tasks/use-recording-tasks";
import { Button } from "@/components/ui/button";
import { HeadingCount } from "@/components/ui/heading-count";
import { InlineEditorTrigger } from "@/components/ui/inline-editor-trigger";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import { detail, task } from "@/tests/meetings/ui-fixtures";
import type { RecordingFolder } from "@/types/folder";

const translate = (
    message: string | { message: string },
    values?: TranslationValues,
) =>
    translatedSourceMessage(
        "en",
        typeof message === "string" ? message : message.message,
        values,
    );
vi.mock("next-intl", () => ({
    useExtracted: () => translate,
    useLocale: () => "en",
    useFormatter: () => ({
        dateTime: (date: Date) => date.toISOString(),
        number: (value: number) => String(value),
    }),
}));

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), fetch: vi.fn() }));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: mocks.refresh, replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/confirm-dialog", () => ({
    useConfirm: () => vi.fn(),
    useOptionalConfirm: () => vi.fn(),
}));
vi.mock("@/lib/events/client", () => ({ subscribeEvents: () => () => {} }));
vi.mock("@/components/recordings/ai-cost-summary", () => ({
    AiCostSummary: () => null,
}));
vi.mock("@/components/recordings/recording-title", () => ({
    RecordingTitle: ({ filename }: { filename: string }) => (
        <span>{filename}</span>
    ),
}));
vi.mock("@/hooks/use-library-preferences", () => ({
    useLibraryPreferences: () => ({
        ready: true,
        preferences: {},
        setPreferences: vi.fn(),
        recentFolders: [],
    }),
}));
vi.mock("@/hooks/use-task-list-data", () => ({
    useTaskListData: () => ({
        tasks: [task("Follow up", null)],
        error: null,
        sortedAssignees: [],
        openCount: 1,
    }),
}));

const folder: RecordingFolder = {
    id: "folder",
    name: "Projects",
    kind: "custom",
    scope: "personal",
    parentId: null,
    sortOrder: 0,
    version: 0,
};
const recording = {
    id: "recording",
    filename: "Planning",
    duration: 1000,
    filesize: 10,
    startTime: "2026-10-01T10:00:00Z",
    deviceSn: "example",
};

function state(): RecordingTasksState {
    return {
        itemId: "recording",
        data: {
            tasks: [task("Dropped task", null, { status: "dropped" })],
            proposals: [task("Proposal", null)],
            matches: [],
            updates: [],
            canEdit: true,
            reviewed: false,
        },
        failed: false,
        reviewing: true,
        waiting: 1,
        accepting: false,
        update: vi.fn(),
        add: vi.fn(),
        merge: vi.fn(),
        tickUpdate: vi.fn(),
        tickMatch: vi.fn(),
        mergeInto: vi.fn(),
        undoMatch: vi.fn(),
        accept: vi.fn(),
    };
}

beforeEach(() => {
    mocks.fetch.mockReset().mockResolvedValue(Response.json({ shares: [] }));
    vi.stubGlobal("fetch", mocks.fetch);
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
    vi.clearAllMocks();
});

function countAfter(title: string, count: string) {
    const heading =
        screen.queryByRole("heading", { name: new RegExp(title) }) ??
        screen.getByText(new RegExp(title));
    const element =
        heading.querySelector('[data-slot="heading-count"]') ??
        heading.nextElementSibling;
    expect(element?.getAttribute("data-slot")).toBe("heading-count");
    expect(element?.textContent?.trim()).toBe(count);
    expect(element?.classList.contains("text-muted-foreground")).toBe(true);
    expect(element?.classList.contains("text-xs")).toBe(true);
    expect(element?.classList.contains("tabular-nums")).toBe(true);
    expect(element?.className).not.toMatch(/ml-auto|rounded|bg-/);
}

describe("block-heading counts", () => {
    it("renders a muted, smaller tabular count without punctuation", () => {
        render(
            <h3>
                Tasks <HeadingCount>5</HeadingCount>
            </h3>,
        );
        countAfter("Tasks", "5");
        expect(screen.getByRole("heading").textContent).toBe("Tasks 5");
    });
    it("separates stored remarks from their count", async () => {
        mocks.fetch.mockResolvedValue(
            Response.json({
                remarks: [],
                preview: { available: false, reason: "profile-unavailable" },
            }),
        );
        render(
            <SummaryRemarksDialog
                itemId="item"
                profileId="profile"
                onClose={vi.fn()}
                onRun={vi.fn()}
            />,
        );
        await screen.findByRole("heading", { name: /Stored remarks/ });
        countAfter("Stored remarks", "0");
        expect(
            screen.getByRole("heading", { name: /Stored remarks/ }).textContent,
        ).not.toContain("(");
    });
    it.each([
        "meeting",
        "live",
        "recording",
    ] as const)("uses one count treatment for both agenda sections in %s", (variant) => {
        const agenda = detail();
        mocks.fetch.mockResolvedValue(Response.json(agenda));
        render(<AgendaBody id="agenda" variant={variant} initial={agenda} />);
        if (variant === "recording")
            fireEvent.click(screen.getByRole("button", { name: /Agenda/ }));
        countAfter("1 · Task review", "0 tasks · 0 done");
        countAfter(
            "2 · Discussion points",
            variant !== "meeting" ? "0 of 1 discussed" : "1 point",
        );
        const header = screen.getByText("2 · Discussion points").parentElement;
        expect(header?.classList.contains("justify-between")).toBe(false);
        const suggest = screen.queryByRole("button", {
            name: "Suggest points",
        });
        if (suggest) expect(suggest.classList.contains("ml-auto")).toBe(true);
    });
    it("uses the shared count in task review sections", () => {
        render(
            <TaskReviewLink
                state={state()}
                speakers={[]}
                organizationOnly={false}
                frame="inline"
            />,
        );
        countAfter("^Tasks", "1");
    });
    it("uses the shared count in Learn section headings and keeps jump pills inline", async () => {
        mocks.fetch.mockResolvedValue(
            Response.json({
                available: true,
                run: { id: "run", status: "ready" },
                names: {},
                types: {},
                relations: {},
                items: [
                    {
                        id: "language",
                        kind: "language",
                        payload: { language: "en", detectedLanguage: "en" },
                        preTicked: true,
                        decision: null,
                        choice: null,
                        version: 0,
                        dependsOnLabel: null,
                    },
                ],
            }),
        );
        render(<LearnWidget recordingId="recording" initialOpen />);
        await screen.findByRole("heading", { name: "Transcript language" });
        countAfter("Transcript language", "1");
    });
    it("uses the shared count in folder task groups", () => {
        render(
            <FolderTasksPanel
                folder={folder}
                organization={{
                    folders: [folder],
                    assignments: [
                        { recordingId: "source", folderId: folder.id },
                    ],
                }}
                onBack={vi.fn()}
            />,
        );
        countAfter("^Projects", "1");
    });
    it("uses the shared count in every profile group and keeps Organization marks blue", async () => {
        const group = {
            profiles: [],
            pagination: { total: 2, page: 1, totalPages: 1 },
        };
        mocks.fetch.mockResolvedValue(
            Response.json({
                permissions: {},
                sections: {
                    organization: group,
                    personal: group,
                    archived: group,
                },
            }),
        );
        render(<ProfilesSection />);
        await screen.findByRole("heading", { name: "Archived" });
        for (const label of ["Organization", "Personal", "Archived"])
            countAfter(`^${label}$`, "2");
        expect(
            screen
                .getByRole("heading", { name: "Organization" })
                .querySelector("svg")
                ?.classList.contains("text-organization"),
        ).toBe(true);
        const hide = screen.getByRole("button", { name: "Hide" });
        expect(hide.getAttribute("aria-pressed")).toBe("true");
        expect(hide.classList.contains("bg-accent")).toBe(true);
        fireEvent.click(hide);
        expect(
            screen
                .getByRole("button", { name: "Show" })
                .getAttribute("aria-pressed"),
        ).toBe("false");
    });
});

describe.each(["audio", "mail"] as const)("%s item controls", (kind) => {
    it.each([
        "private",
        "org",
        "received",
    ] as const)("colours Knowledge only while open in %s", (view) => {
        function Header() {
            const [open, setOpen] = useState(false);
            return (
                <ItemHeader
                    itemId="item"
                    kind={kind}
                    title="Example"
                    metadata={[]}
                    view={view}
                    onKnowledge={() => setOpen(!open)}
                    knowledgeOpen={open}
                />
            );
        }
        render(<Header />);
        const button = screen.getByRole("button", { name: "Knowledge" });
        expect(button.querySelector("svg")?.getAttribute("class")).not.toMatch(
            /text-(organization|knowledge)/,
        );
        fireEvent.click(button);
        expect(button.getAttribute("aria-pressed")).toBe("true");
        expect(button.classList.contains("bg-accent")).toBe(true);
        expect(
            button.querySelector("svg")?.classList.contains("text-knowledge"),
        ).toBe(true);
        fireEvent.click(button);
        expect(button.getAttribute("aria-pressed")).toBe("false");
        expect(
            button.querySelector("svg")?.classList.contains("text-knowledge"),
        ).toBe(false);
    });
    it.each([
        false,
        true,
    ])("colours Share only for an existing person share: %s", async (sharedWithPerson) => {
        mocks.fetch.mockResolvedValue(
            Response.json({
                shares: sharedWithPerson
                    ? [
                          {
                              id: "share",
                              state: "accepted",
                              receiverUserId: "receiver",
                          },
                      ]
                    : [],
            }),
        );
        render(
            <OwnerSharingActions
                itemId="item"
                title="Example"
                kind={kind}
                copyLink={vi.fn()}
                shared={false}
                open={false}
                onOpenChange={vi.fn()}
                onCountChange={vi.fn()}
            />,
        );
        await act(async () => {});
        expect(
            screen
                .getByRole("button", { name: "Share" })
                .classList.contains("text-person-share"),
        ).toBe(sharedWithPerson);
    });
});

describe("inline editors", () => {
    it("ignores mouse and keyboard activation while open, retains the draft, and returns focus", () => {
        function Editor() {
            const [open, setOpen] = useState(false);
            const trigger = useRef<HTMLButtonElement>(null);
            return (
                <>
                    <InlineEditorTrigger
                        ref={trigger}
                        open={open}
                        variant="ghost"
                        onClick={() => setOpen(true)}
                    >
                        Edit
                    </InlineEditorTrigger>
                    {open && (
                        <>
                            <input aria-label="Draft" />
                            <Button
                                onClick={() => {
                                    setOpen(false);
                                    trigger.current?.focus();
                                }}
                            >
                                Cancel
                            </Button>
                        </>
                    )}
                </>
            );
        }
        render(<Editor />);
        const trigger = screen.getByRole("button", { name: "Edit" });
        fireEvent.click(trigger);
        expect(trigger.getAttribute("aria-disabled")).toBe("true");
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
        expect(trigger.classList.contains("aria-disabled:opacity-50")).toBe(
            true,
        );
        // No hover state at all while open: neither background nor text.
        expect(
            trigger.classList.contains("aria-disabled:pointer-events-none"),
        ).toBe(true);
        fireEvent.change(screen.getByRole("textbox"), {
            target: { value: "Keep this" },
        });
        fireEvent.click(trigger);
        fireEvent.keyDown(trigger, { key: "Enter" });
        fireEvent.keyDown(trigger, { key: " " });
        fireEvent.click(trigger, { detail: 0 });
        expect(screen.getByRole<HTMLInputElement>("textbox").value).toBe(
            "Keep this",
        );
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(document.activeElement).toBe(trigger);
        expect(trigger.getAttribute("aria-disabled")).toBe("false");
    });
    it.each([
        "Skip",
        "Save note",
    ])("keeps the task Note trigger inactive and returns focus after %s", (action) => {
        const change = vi.fn();
        render(
            <ul>
                <TaskRow
                    task={task("Follow up", null)}
                    organizationOnly={false}
                    onChange={change}
                />
            </ul>,
        );
        const trigger = screen.getByRole("button", { name: "Note" });
        fireEvent.click(trigger);
        expect(trigger.getAttribute("aria-disabled")).toBe("true");
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
        const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
            name: "Note",
        });
        fireEvent.change(input, { target: { value: "Keep the draft" } });
        fireEvent.click(trigger);
        expect(input.value).toBe("Keep the draft");
        expect(change).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: action }));
        expect(document.activeElement).toBe(trigger);
    });
    it.each([
        "Cancel",
        "Save",
    ])("keeps the meeting note trigger inactive and returns focus after %s", async (action) => {
        const agenda = detail({
            state: "live",
            tasks: [task("Follow up", null, { agendaNote: "Existing" })],
        });
        mocks.fetch.mockResolvedValue(Response.json(agenda));
        render(<AgendaBody id="agenda" initial={agenda} userId="owner" />);
        const trigger = screen.getByRole("button", { name: "Meeting note" });
        fireEvent.click(trigger);
        expect(trigger.getAttribute("aria-disabled")).toBe("true");
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
        fireEvent.change(
            screen.getByRole("textbox", { name: "Meeting note for Follow up" }),
            { target: { value: "Draft" } },
        );
        fireEvent.click(trigger);
        expect(screen.getByDisplayValue("Draft")).toBeTruthy();
        await act(async () =>
            fireEvent.click(screen.getByRole("button", { name: action })),
        );
        expect(document.activeElement).toBe(trigger);
    });
    it.each([
        false,
        true,
    ])("keeps Add person inactive, with cancellation in the form (empty=%s)", (empty) => {
        render(
            <PeopleList
                people={
                    empty
                        ? []
                        : [
                              {
                                  id: "person",
                                  displayName: "Robin Fern",
                                  primaryEmail: null,
                                  recordingCount: 0,
                                  lastSeen: null,
                              },
                          ]
                }
            />,
        );
        const trigger = screen.getByRole("button", {
            name: empty ? "Add your first person" : "Add person",
        });
        fireEvent.click(trigger);
        expect(trigger.getAttribute("aria-disabled")).toBe("true");
        if (empty) {
            expect(trigger.classList.contains("bg-primary")).toBe(true);
            expect(trigger.classList.contains("text-primary-foreground")).toBe(
                true,
            );
        }
        expect(
            trigger.classList.contains("aria-disabled:pointer-events-none"),
        ).toBe(true);
        fireEvent.change(
            screen.getByRole("textbox", { name: "Name of the person to add" }),
            { target: { value: "Robin Fern" } },
        );
        fireEvent.click(trigger);
        expect(screen.getByDisplayValue("Robin Fern")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(document.activeElement).toBe(trigger);
    });
    it.each([
        false,
        true,
    ])("keeps Add thing inactive, with cancellation in the form (empty=%s)", (empty) => {
        render(
            <ThingsList
                things={
                    empty
                        ? []
                        : [
                              {
                                  id: "thing",
                                  name: "Acme",
                                  typeKey: "company",
                                  description: null,
                                  scope: "personal",
                              },
                          ]
                }
                typeLabels={{}}
                types={[{ key: "company", label: "Company" }]}
            />,
        );
        const trigger = screen.getByRole("button", { name: "Add thing" });
        fireEvent.click(trigger);
        expect(trigger.getAttribute("aria-disabled")).toBe("true");
        fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
            target: { value: "Acme" },
        });
        fireEvent.click(trigger);
        expect(screen.getByDisplayValue("Acme")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(document.activeElement).toBe(trigger);
    });
});

describe("neutral commands and coloured open views", () => {
    it.each([
        "menu",
        "context",
    ])("keeps folder agenda and share commands neutral through the %s menu", async (mode) => {
        render(
            <PersonSharingProvider value>
                <FolderTree
                    folders={[folder]}
                    assignments={[]}
                    recordings={[]}
                    selectedFolderId={null}
                    onRecent={vi.fn()}
                    onSelectFolder={vi.fn()}
                    onMoveFolder={vi.fn()}
                    onAssignRecording={vi.fn()}
                    onSettings={vi.fn()}
                    onPrepareMeeting={vi.fn()}
                />
            </PersonSharingProvider>,
        );
        if (mode === "context")
            fireEvent.contextMenu(
                screen.getByRole("group", { name: "Projects" }),
            );
        else
            fireEvent.pointerDown(
                screen.getByRole("button", {
                    name: "Folder actions for Projects",
                }),
                { button: 0, ctrlKey: false },
            );
        for (const name of ["Prepare an agenda", "Share folder…"]) {
            const item = await screen.findByRole("menuitem", { name });
            expect(
                item.querySelector("svg")?.getAttribute("class"),
            ).not.toMatch(/text-(meeting|person-share)/);
        }
    });
    it("keeps item-menu sharing and destructive menu commands neutral at rest", async () => {
        render(
            <PersonSharingProvider value>
                <RecordingRow
                    recording={recording}
                    isSelected={false}
                    inFlight={undefined}
                    snippet={null}
                    isCompact={false}
                    rowPadding="p-2"
                    dateTimeFormat="relative"
                    onSelect={vi.fn()}
                    onDelete={vi.fn()}
                    registerRef={vi.fn()}
                />
            </PersonSharingProvider>,
        );
        fireEvent.pointerDown(
            screen.getByRole("button", { name: "Row actions" }),
            { button: 0, ctrlKey: false },
        );
        expect(
            (await screen.findByRole("menuitem", { name: "Share…" }))
                .querySelector("svg")
                ?.getAttribute("class"),
        ).not.toContain("text-person-share");
        const remove = screen.getByRole("menuitem", { name: "Delete" });
        expect(
            remove.classList.contains(
                "data-[variant=destructive]:text-destructive",
            ),
        ).toBe(false);
        expect(
            remove.classList.contains(
                "data-[variant=destructive]:focus:text-red-700",
            ),
        ).toBe(true);
    });
    it.each([
        "API key",
        "webhook",
    ])("keeps %s trash neutral at rest and red on hover/focus", async (kind) => {
        mocks.fetch.mockResolvedValue(
            Response.json(
                kind === "API key"
                    ? {
                          apiKeys: [
                              {
                                  id: "key",
                                  name: "Automation",
                                  keyPrefix: "example",
                                  createdAt: "2026-10-01T00:00:00Z",
                              },
                          ],
                      }
                    : {
                          webhooks: [
                              {
                                  id: "webhook",
                                  url: "https://example.com/hook",
                                  events: [],
                                  enabled: true,
                              },
                          ],
                          events: [],
                      },
            ),
        );
        render(kind === "API key" ? <ApiKeysSection /> : <WebhooksSection />);
        const remove = await screen.findByRole("button", {
            name: kind === "API key" ? "Revoke Automation" : "Delete webhook",
        });
        expect(
            remove.querySelector("svg")?.classList.contains("text-destructive"),
        ).toBe(false);
        expect(remove.classList.contains("text-muted-foreground")).toBe(true);
        for (const value of [
            "hover:text-red-600",
            "focus-visible:text-red-600",
            "dark:hover:text-red-400",
        ])
            expect(remove.classList.contains(value)).toBe(true);
    });
    it("keeps received-item filing neutral while its sharing scope retains magenta", () => {
        render(
            <ReceivedItemBanner
                recording={{
                    ...recording,
                    view: "received",
                    receivedShare: {
                        id: "share",
                        version: 0,
                        filingFolderId: "folder",
                    },
                }}
                folders={[]}
            />,
        );
        expect(
            screen
                .getByRole("button", { name: "Choose a folder" })
                .classList.contains("text-person-share"),
        ).toBe(false);
    });
    it("keeps the recording Agenda disclosure neutral with expandable metadata", () => {
        const agenda = detail();
        mocks.fetch.mockResolvedValue(Response.json(agenda));
        render(<AgendaBody id="agenda" variant="recording" initial={agenda} />);
        const trigger = screen.getByRole("button", { name: /Agenda/ });
        const label = within(trigger).getByText("Agenda");
        const metadata = within(trigger).getByText(/0 of 1 point discussed/);
        expect(
            trigger.classList.contains("grid-cols-[auto_minmax(0,1fr)_auto]"),
        ).toBe(true);
        expect(label.classList.contains("whitespace-nowrap")).toBe(true);
        expect(metadata.classList.contains("text-right")).toBe(true);
        expect(metadata.classList.contains("shrink-0")).toBe(false);
        expect(
            trigger.querySelector("svg")?.classList.contains("shrink-0"),
        ).toBe(true);
        for (const expanded of [false, true, false]) {
            expect(trigger.getAttribute("aria-expanded")).toBe(
                String(expanded),
            );
            expect(trigger.hasAttribute("aria-pressed")).toBe(false);
            expect(trigger.className).not.toMatch(/text-meeting|bg-accent/);
            expect(Boolean(screen.queryByText("1 · Task review"))).toBe(
                expanded,
            );
            fireEvent.click(trigger);
        }
    });
    it("reveals and hides dropped tasks through a neutral disclosure", () => {
        const tasks = state();
        tasks.reviewing = false;
        render(
            <RecordingTasks
                state={tasks}
                speakers={[]}
                organizationOnly={false}
                fallback={null}
            />,
        );
        const trigger = screen.getByRole("button", {
            name: "Show dropped (1)",
        });
        for (const expanded of [false, true, false]) {
            expect(trigger.getAttribute("aria-expanded")).toBe(
                String(expanded),
            );
            expect(trigger.hasAttribute("aria-pressed")).toBe(false);
            expect(trigger.className).not.toMatch(/text-tasks|bg-accent/);
            expect(Boolean(screen.queryByText("Dropped task"))).toBe(expanded);
            fireEvent.click(trigger);
        }
    });
    it("uses neutral borders and icons for task and meeting notes", () => {
        const agenda = detail({
            tasks: [
                task("Follow up", null, {
                    note: "Task note text",
                    agendaNote: "Meeting note text",
                }),
            ],
        });
        mocks.fetch.mockResolvedValue(Response.json(agenda));
        render(<AgendaBody id="agenda" initial={agenda} />);
        for (const text of ["Task note text", "Meeting note text"]) {
            const note = screen.getByText(text).closest(".border-l-2");
            expect(note?.classList.contains("border-border")).toBe(true);
            expect(note?.className).not.toMatch(
                /border-(tasks|meeting|primary)/,
            );
            expect(
                note?.querySelector("svg")?.getAttribute("class"),
            ).not.toMatch(/text-(tasks|meeting|primary)/);
        }
    });
});

describe("full-width counts", () => {
    it("keeps overflow arrivals at the right of the name row", () => {
        render(
            <ArrivalNotice
                recording={recording}
                more={3}
                dateTimeFormat="relative"
                onOpen={vi.fn()}
                onClose={vi.fn()}
            />,
        );
        expect(screen.getByText("+3 more").classList.contains("ml-auto")).toBe(
            true,
        );
        expect(
            screen
                .getByText("+3 more")
                .parentElement?.classList.contains("flex-1"),
        ).toBe(true);
    });
    it("puts the topic count after a flexible topic name", () => {
        render(
            <TranscriptTopicsMenu
                topics={[{ title: "Planning", fromMs: 0, toMs: 1000 }]}
                canDetect={false}
                detecting={false}
                onDetect={vi.fn()}
                onSelect={vi.fn()}
                widgetId="topics"
            />,
        );
        const title = screen.getByText("Planning");
        expect(title.classList.contains("flex-1")).toBe(true);
        expect(title.nextElementSibling?.textContent).toBe("1 / 1");
    });
    it("aligns review filter counts like channel counts", async () => {
        render(
            <RecordingListToolbar
                query=""
                onQueryChange={vi.fn()}
                onEnterSelectFirst={vi.fn()}
                searchRef={{ current: null }}
                channelCounts={{ audio: 1, mail: 2 }}
                sortOrder="newest"
                onSortOrderChange={vi.fn()}
                reviewCount={4}
                onNeedsReviewOnlyChange={vi.fn()}
                showMail
                kindFilter="all"
                onKindFilterChange={vi.fn()}
                searchScopes={new Set(["title"])}
                onSearchScopesChange={vi.fn()}
            />,
        );
        fireEvent.pointerDown(
            screen.getByRole("button", { name: /Filter and sort/ }),
            { button: 0, ctrlKey: false },
        );
        const item = await screen.findByRole("menuitemcheckbox", {
            name: "Needs review 4",
        });
        expect(within(item).getByText("4").classList.contains("ml-auto")).toBe(
            true,
        );
    });
});
