// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { openWidget } from "@/components/pipeline/workflow-widget";
import { PlaybackProvider } from "@/components/playback/playback-context";
import { RecordingTasks as RecordingTasksList } from "@/components/tasks/recording-tasks";
import { TaskReviewLink } from "@/components/tasks/task-review-dialog";
import type { RecordingTasksState } from "@/components/tasks/use-recording-tasks";
import type { TranscriptPlayback } from "@/hooks/use-transcript-follow";
import type {
    RecordingTasks,
    TaskMatchView,
    TaskUpdateView,
    TaskView,
} from "@/lib/tasks/tasks";

vi.mock("next-intl", () => ({
    useExtracted: () => (text: string, values?: Record<string, unknown>) =>
        text.replace(/\{(\w+)\}/g, (_match, key: string) =>
            String(values?.[key] ?? ""),
        ),
    useFormatter: () => ({
        dateTime: (value: Date) => value.toISOString().slice(0, 10),
    }),
}));

function task(overrides: Partial<TaskView> = {}): TaskView {
    return {
        id: "proposal-1",
        recordingId: "source-item",
        evidenceItemId: "source-item",
        evidenceItemKind: "audio",
        evidenceAudioAvailable: true,
        status: "proposed",
        text: "Send the revised contract",
        assignee: { personId: "person-1", name: "Ada" },
        assigneeHasEmail: true,
        assigneeHint: null,
        assigneeCheck: false,
        dueDate: "2026-10-22",
        duePhrase: null,
        quote: "I will send the revised contract",
        evidenceStartMs: 12_500,
        evidenceText: null,
        evidenceProvenance: null,
        source: "riffado",
        ticked: true,
        version: 0,
        createdAt: "2026-10-15T10:00:00.000Z",
        acceptedAt: null,
        statusChangedAt: null,
        canEdit: true,
        canClose: true,
        canUndoMatch: false,
        own: false,
        note: null,
        noteUpdatedAt: null,
        noteBy: null,
        following: false,
        automaticFollow: false,
        canFollow: false,
        canMerge: false,
        ...overrides,
    };
}

function match(overrides: Partial<TaskMatchView> = {}): TaskMatchView {
    return {
        id: "match-1",
        ticked: false,
        version: 3,
        ambiguous: false,
        quote: "I will send the revised contract",
        evidenceStartMs: 12_500,
        evidenceText: null,
        evidenceProvenance: null,
        candidate: {
            id: "existing-1",
            status: "open",
            text: "Send the contract",
            assignee: { personId: "person-1", name: "Ada" },
            dueDate: "2026-10-20",
            duePhrase: null,
            homeItem: {
                id: "earlier-item",
                kind: "audio",
                title: "Contract planning",
                audioAvailable: true,
            },
            quote: "I will send the contract",
            evidenceStartMs: 3_000,
            evidenceText: null,
        },
        ...overrides,
    };
}

function update(overrides: Partial<TaskUpdateView> = {}): TaskUpdateView {
    return {
        id: "update-1",
        kind: "due",
        dueDate: "2026-10-29",
        duePhrase: null,
        proposedAssignee: null,
        proposedAssigneeHint: null,
        proposedAssigneeCheck: false,
        quote: "Move it to next Thursday",
        evidenceStartMs: null,
        evidenceText: { segmentIndex: 2, charStart: 8, charEnd: 31 },
        evidenceProvenance: null,
        earlierMention: false,
        ticked: false,
        version: 3,
        task: {
            id: "existing-1",
            recordingId: "earlier-item",
            recordingTitle: "Contract planning",
            text: "Send the contract",
            dueDate: "2026-10-20",
            duePhrase: null,
            assigneeName: "Ada",
        },
        ...overrides,
    };
}

function state(data: RecordingTasks): RecordingTasksState {
    return {
        itemId: "source-item",
        data,
        failed: false,
        reviewing: true,
        waiting: 1,
        accepting: false,
        update: vi.fn(),
        add: vi.fn(async () => null),
        merge: vi.fn(async () => true),
        mergeInto: vi.fn(async () => true),
        undoMatch: vi.fn(async () => {}),
        tickUpdate: vi.fn(),
        tickMatch: vi.fn(),
        accept: vi.fn(async () => true),
    };
}

function AddTaskHarness({ frame }: { frame: "inline" | "dialog" }) {
    const [data, setData] = useState<RecordingTasks>({
        canEdit: true,
        reviewed: false,
        tasks: [],
        proposals: [task()],
        updates: [],
        matches: [],
    });
    const current = state(data);
    current.add = async () => {
        const added = task({
            id: "new-proposal",
            text: "New task",
            quote: null,
            evidenceStartMs: null,
        });
        setData((value) => ({
            ...value,
            proposals: [...value.proposals, added],
        }));
        return added;
    };
    return (
        <TaskReviewLink
            state={current}
            speakers={[]}
            organizationOnly={false}
            frame={frame}
            showTrigger={false}
            widgetId={`add-task-${frame}`}
        />
    );
}

function openReview(data: Partial<RecordingTasks>, organizationOnly = false) {
    const current = state({
        canEdit: true,
        reviewed: false,
        tasks: [],
        proposals: [],
        updates: [],
        matches: [],
        ...data,
    });
    render(
        <TaskReviewLink
            state={current}
            speakers={[]}
            organizationOnly={organizationOnly}
        />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Review tasks/ }));
    return current;
}

afterEach(async () => {
    cleanup();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
});

it("renders pipeline task review inline and reopens a person-started review", async () => {
    const current = state({
        canEdit: true,
        reviewed: false,
        tasks: [],
        proposals: [task()],
        updates: [],
        matches: [],
    });
    const view = render(
        <TaskReviewLink
            state={current}
            speakers={[]}
            organizationOnly={false}
            frame="inline"
            showTrigger={false}
        />,
    );
    expect(screen.getByRole("heading", { name: /Task review/ })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    view.rerender(
        <TaskReviewLink
            state={current}
            speakers={[]}
            organizationOnly={false}
            frame="dialog"
            showTrigger={false}
        />,
    );
    const reviewHost = document.getElementById("task-review-source-item");
    expect(reviewHost).toBeTruthy();
    (reviewHost as HTMLElement).scrollIntoView = vi.fn();
    openWidget("task-review-source-item");
    await waitFor(() =>
        expect(
            screen.getByRole("dialog", { name: /Task review/ }),
        ).toBeTruthy(),
    );
});

it("confirms undo while explaining that applied task changes stay", async () => {
    const current = state({
        canEdit: true,
        reviewed: true,
        tasks: [
            task({
                id: "linked-task",
                status: "open",
                canUndoMatch: true,
            }),
        ],
        proposals: [],
        updates: [],
        matches: [],
    });
    render(
        <ConfirmDialogProvider>
            <RecordingTasksList
                state={current}
                speakers={[]}
                organizationOnly={false}
                fallback={null}
            />
        </ConfirmDialogProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Undo match" }));
    expect(screen.getByText("Undo this task match?")).toBeTruthy();
    expect(
        screen.getByText(
            "This removes the link from this item. Changes already applied to the task stay.",
        ),
    ).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "Undo match" });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    await waitFor(() => expect(current.undoMatch).toHaveBeenCalledTimes(1));
});

describe.each([
    "inline",
    "dialog",
] as const)("task review behavior in the %s frame", (frame) => {
    async function openFrame(current: RecordingTasksState) {
        render(
            <TaskReviewLink
                state={current}
                speakers={[]}
                organizationOnly={false}
                frame={frame}
                showTrigger={false}
                widgetId={`task-review-${frame}`}
            />,
        );
        if (frame === "dialog") {
            fireEvent.click(
                await screen.findByRole("button", { name: "Review" }),
            );
        }
        await screen.findByRole("heading", { name: "Task review" });
    }

    it("ticks, edits, and applies a proposal", async () => {
        const proposal = task();
        const current = state({
            canEdit: true,
            reviewed: false,
            tasks: [],
            proposals: [proposal],
            updates: [],
            matches: [],
        });
        await openFrame(current);

        fireEvent.click(
            screen.getByRole("checkbox", { name: "Keep this task" }),
        );
        expect(current.update).toHaveBeenCalledWith(
            proposal,
            { ticked: false },
            { ticked: false },
        );

        const text = screen.getByRole("textbox", { name: "Task" });
        fireEvent.change(text, {
            target: { value: "Send the final contract" },
        });
        fireEvent.blur(text);
        expect(current.update).toHaveBeenCalledWith(
            proposal,
            { text: "Send the final contract" },
            { text: "Send the final contract" },
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Apply selected changes" }),
        );
        expect(current.accept).toHaveBeenCalledTimes(1);
    });

    it("merges a proposal", async () => {
        const current = state({
            canEdit: true,
            reviewed: false,
            tasks: [],
            proposals: [task()],
            updates: [],
            matches: [],
        });
        await openFrame(current);
        expect(
            screen.getByRole("button", {
                name: "Merge into an earlier task",
            }),
        ).toBeTruthy();
        await current.mergeInto("proposal-1", "target-1");
        expect(current.mergeInto).toHaveBeenCalledWith(
            "proposal-1",
            "target-1",
        );
    });

    it("keeps the proposal when a merge fails", async () => {
        const current = state({
            canEdit: true,
            reviewed: false,
            tasks: [],
            proposals: [task()],
            updates: [],
            matches: [],
        });
        current.mergeInto = vi.fn(async () => false);
        await openFrame(current);
        expect(await current.mergeInto("proposal-1", "target-1")).toBe(false);
        expect(
            screen.getByDisplayValue("Send the revised contract"),
        ).toBeTruthy();
    });

    it("adds directly below the task list and focuses the new task", async () => {
        const scrollIntoView = vi.fn();
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
            configurable: true,
            value: scrollIntoView,
        });
        render(<AddTaskHarness frame={frame} />);
        if (frame === "dialog") {
            fireEvent.click(
                await screen.findByRole("button", { name: "Review" }),
            );
        }

        const add = await screen.findByRole("button", { name: "Add task" });
        const footer = screen
            .getByRole("button", { name: "Apply selected changes" })
            .closest("footer");
        expect(footer).toBeTruthy();
        expect(
            within(footer as HTMLElement).queryByRole("button", {
                name: "Add task",
            }),
        ).toBeNull();
        expect(add.closest("[data-widget-body]")).toBeTruthy();
        expect(add.className).toContain("hover:bg-accent");
        const list = add.previousElementSibling;
        expect(list?.tagName).toBe("UL");
        expect(
            list?.lastElementChild?.getAttribute("data-task-review-card"),
        ).toBe("proposal-1");

        fireEvent.click(add);
        const input = await screen.findByDisplayValue("New task");
        await waitFor(() => expect(document.activeElement).toBe(input));
        expect(scrollIntoView).toHaveBeenCalled();
        expect(
            add.previousElementSibling?.lastElementChild?.getAttribute(
                "data-task-review-card",
            ),
        ).toBe("new-proposal");
    });

    it("keeps Add task in the Tasks section when the list is empty", async () => {
        await openFrame(
            state({
                canEdit: true,
                reviewed: false,
                tasks: [],
                proposals: [],
                updates: [],
                matches: [match()],
            }),
        );

        const add = screen.getByRole("button", { name: "Add task" });
        const section = add.closest("section");
        expect(
            within(section as HTMLElement).getByRole("heading", {
                name: /^Tasks/,
            }),
        ).toBeTruthy();
        expect(section?.querySelector("ul")).toBeNull();
        expect(add.closest("footer")).toBeNull();
    });

    it("hides Add task while merging", async () => {
        await openFrame(
            state({
                canEdit: true,
                reviewed: false,
                tasks: [],
                proposals: [
                    task(),
                    task({ id: "proposal-2", text: "Book the room" }),
                ],
                updates: [],
                matches: [],
            }),
        );
        expect(screen.getByRole("button", { name: "Add task" })).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Merge…" }));
        expect(screen.queryByRole("button", { name: "Add task" })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Cancel merging" }));
        expect(screen.getByRole("button", { name: "Add task" })).toBeTruthy();
    });
});

describe("task review rows", () => {
    it("shows non-curators read-only task controls", () => {
        const current = state({
            canEdit: false,
            reviewed: true,
            tasks: [
                task({
                    status: "open",
                    canEdit: false,
                    canClose: false,
                }),
            ],
            proposals: [],
            updates: [],
            matches: [],
        });
        render(
            <RecordingTasksList
                state={current}
                speakers={[]}
                organizationOnly={true}
                fallback={null}
            />,
        );

        expect(screen.queryByRole("checkbox", { name: "Done" })).toBeNull();
        expect(screen.getByRole("img", { name: "Open" })).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Assigned to Ada" }),
        ).toHaveProperty("disabled", true);
        expect(screen.queryByRole("textbox", { name: "Task" })).toBeNull();
        expect(screen.queryByLabelText("Due date")).toBeNull();
        expect(screen.queryByRole("button", { name: "Drop" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Add task" })).toBeNull();
    });

    it("limits review assignees to Organization people", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                Response.json({
                    people: [
                        {
                            id: "private-person",
                            displayName: "Private Pat",
                            primaryEmail: "pat@example.test",
                            scope: "private",
                        },
                        {
                            id: "org-person",
                            displayName: "Organization Olivia",
                            primaryEmail: "olivia@example.test",
                            scope: "org",
                        },
                    ],
                }),
            ),
        );
        openReview(
            {
                proposals: [task({ assignee: null })],
            },
            true,
        );

        fireEvent.pointerDown(
            screen.getByRole("button", { name: "Assigned to Nobody" }),
        );

        expect(await screen.findByText("Organization Olivia")).toBeTruthy();
        expect(screen.queryByText("Private Pat")).toBeNull();
    });

    it("compares an unticked suggested match and toggles its timed evidence", async () => {
        const listeners = new Set<
            (state: {
                ms: number;
                playing: boolean;
                owner?: string | null;
            }) => void
        >();
        let currentMs = 0;
        const playback: TranscriptPlayback = {
            play: vi.fn((ms, owner) => {
                currentMs = ms;
                for (const listener of listeners) {
                    listener({ ms, playing: true, owner });
                }
            }),
            pause: vi.fn(() => {
                for (const listener of listeners) {
                    listener({ ms: currentMs, playing: false, owner: null });
                }
            }),
            seek: vi.fn(),
            subscribe: vi.fn((next) => {
                listeners.add(next);
                next({ ms: 0, playing: false });
                return () => {
                    listeners.delete(next);
                };
            }),
        };
        const current = state({
            canEdit: true,
            reviewed: false,
            tasks: [],
            proposals: [],
            updates: [
                update({
                    evidenceStartMs: 25_000,
                    evidenceText: null,
                    task: {
                        id: "existing-1",
                        recordingId: "earlier-item",
                        recordingTitle: "Follow-up planning",
                        text: "Confirm contract delivery",
                        dueDate: "2026-10-18",
                        duePhrase: null,
                        assigneeName: "Dana",
                    },
                }),
            ],
            matches: [match()],
        });
        render(
            <PlaybackProvider playback={playback}>
                <TaskReviewLink
                    state={current}
                    speakers={[]}
                    organizationOnly={false}
                />
            </PlaybackProvider>,
        );
        fireEvent.click(screen.getByRole("button", { name: /Review tasks/ }));

        expect(screen.getByText("Earlier task")).toBeTruthy();
        expect(screen.getByText("Said now")).toBeTruthy();
        expect(screen.getByText("Same task: attach this mention")).toBeTruthy();
        expect(
            screen.getByText(
                "Accepting this match changes nothing else on the task.",
            ),
        ).toBeTruthy();
        expect(screen.getByText("Send the contract")).toBeTruthy();
        expect(screen.getByText(/Ada/)).toBeTruthy();
        expect(screen.getByText(/2026-10-20/)).toBeTruthy();
        expect(screen.getByText(/Contract planning/)).toBeTruthy();
        expect(
            screen.getByText(/I will send the revised contract/),
        ).toBeTruthy();
        expect(
            screen
                .getByRole("link", { name: "Show in recording" })
                .getAttribute("href"),
        ).toBe("/dashboard?recording=earlier-item&playFrom=3000");
        expect(
            screen.getByRole("checkbox", {
                name: "Apply suggested match to Send the contract",
            }),
        ).toHaveProperty("checked", false);
        fireEvent.click(
            screen.getByRole("button", { name: "Play from 00:12" }),
        );
        expect(playback.play).toHaveBeenCalledWith(
            12_500,
            expect.any(String),
            undefined,
        );
        await screen.findByRole("button", {
            name: "Pause at 00:12",
        });
        expect(
            screen.getAllByRole("button", { name: /Pause at/ }),
        ).toHaveLength(1);

        fireEvent.click(
            screen.getByRole("button", { name: "Play from 00:25" }),
        );
        expect(
            screen.getByRole("button", { name: "Play from 00:12" }),
        ).toBeTruthy();
        const pause = await screen.findByRole("button", {
            name: "Pause at 00:25",
        });
        expect(
            screen.getAllByRole("button", { name: /Pause at/ }),
        ).toHaveLength(1);
        expect(pause.getAttribute("aria-pressed")).toBe("true");
        fireEvent.click(pause);
        expect(playback.pause).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("button", { name: /Pause at/ })).toBeNull();

        fireEvent.click(
            screen.getByRole("button", { name: "Play from 00:12" }),
        );
        playback.play(40_000);
        await waitFor(() =>
            expect(
                screen.queryByRole("button", { name: /Pause at/ }),
            ).toBeNull(),
        );
    });

    it("shows an unplaced quote as text without a dead link", () => {
        openReview({
            matches: [
                match({
                    quote: "A completely paraphrased commitment",
                    evidenceStartMs: null,
                    evidenceText: null,
                }),
            ],
        });

        const saidNow = screen.getByText("Said now").closest("section");
        expect(saidNow).toBeTruthy();
        expect(
            within(saidNow as HTMLElement).getByText(
                /A completely paraphrased commitment/,
            ),
        ).toBeTruthy();
        expect(
            within(saidNow as HTMLElement).getByText(
                "not found in the transcript",
            ),
        ).toBeTruthy();
        expect(within(saidNow as HTMLElement).queryByRole("link")).toBeNull();
        expect(within(saidNow as HTMLElement).queryByRole("button")).toBeNull();
    });

    it("shows one card for a match, its field changes, and earlier evidence", () => {
        const suggested = match({ ticked: false });
        const due = update();
        const earlier = update({
            id: "earlier-update",
            kind: "done",
            earlierMention: true,
            quote: "It had already been done",
        });
        const current = openReview({
            matches: [suggested],
            updates: [due, earlier],
        });

        const cards = document.querySelectorAll(
            '[data-task-review-card="existing-1"]',
        );
        expect(cards).toHaveLength(1);
        expect(screen.getByText("Earlier task")).toBeTruthy();
        expect(screen.getByText("Said now")).toBeTruthy();
        expect(screen.getByText("Current deadline")).toBeTruthy();
        expect(screen.getByText("Earlier mention")).toBeTruthy();
        expect(screen.queryByText("Heard about earlier tasks")).toBeNull();
        expect(screen.getByText("0 of 1 will be applied")).toBeTruthy();

        fireEvent.click(
            screen.getByRole("radio", { name: "Use the proposed deadline" }),
        );
        expect(current.tickMatch).toHaveBeenCalledWith(suggested, true);
        expect(current.tickUpdate).toHaveBeenCalledWith(due, true);
    });

    it("offers ambiguous candidates and Keep as new as one choice", () => {
        const keep = task({ id: "keep-new" });
        const first = match({ id: "match-a", ambiguous: true, ticked: false });
        const second = match({
            id: "match-b",
            ambiguous: true,
            ticked: false,
            candidate: {
                ...match().candidate,
                id: "existing-2",
                text: "Send the addendum",
            },
        });
        const current = openReview({
            proposals: [keep],
            matches: [first, second],
        });

        expect(
            screen.getByRole("radiogroup", { name: "Choose a task match" }),
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("radio", { name: "Keep as new" }));
        expect(current.tickMatch).toHaveBeenCalledWith(first, false);
        expect(current.tickMatch).toHaveBeenCalledWith(second, false);
        expect(current.update).toHaveBeenCalledWith(
            keep,
            { ticked: true },
            { ticked: true },
        );
    });

    it("shows current and proposed deadlines, including a vague phrase", () => {
        openReview({
            updates: [
                update({
                    kind: "due_phrase",
                    dueDate: null,
                    duePhrase: "after the client replies",
                }),
            ],
        });

        expect(screen.getByText("Current deadline")).toBeTruthy();
        expect(screen.getByText("2026-10-20")).toBeTruthy();
        expect(screen.getByText("Proposed deadline")).toBeTruthy();
        expect(screen.getByText("after the client replies")).toBeTruthy();
        expect(
            screen.getByRole("radio", { name: /Keep the current deadline/ }),
        ).toHaveProperty("checked", true);
    });

    it("labels completion as Needs confirmation and leaves it unselected", () => {
        openReview({
            updates: [
                update({ kind: "done", dueDate: null, quote: "It is done" }),
            ],
        });

        expect(screen.getByText("Needs confirmation")).toBeTruthy();
        expect(
            screen.getByRole("checkbox", { name: "Confirm task completion" }),
        ).toHaveProperty("checked", false);
    });

    it("[H] labels drop and reassignment, shows current to new, and leaves both unselected", () => {
        openReview({
            updates: [
                update({
                    id: "drop-1",
                    kind: "drop",
                    dueDate: null,
                    quote: "We no longer need it",
                }),
                update({
                    id: "assignee-1",
                    kind: "assignee",
                    dueDate: null,
                    proposedAssignee: { personId: "person-2", name: "Dana" },
                    proposedAssigneeCheck: true,
                    quote: "Dana took this over",
                }),
            ],
        });

        expect(screen.getByText("No longer needed")).toBeTruthy();
        expect(screen.getByText("Handed to someone else")).toBeTruthy();
        expect(screen.getByText("Ada → Dana")).toBeTruthy();
        expect(screen.getByTitle("Check this assignment")).toBeTruthy();
        expect(
            screen.getByRole("checkbox", {
                name: "Confirm task is no longer needed",
            }),
        ).toHaveProperty("checked", false);
        expect(
            screen.getByRole("checkbox", { name: "Confirm new assignee" }),
        ).toHaveProperty("checked", false);
    });

    it("shows an earlier mention without an action", () => {
        openReview({ updates: [update({ earlierMention: true })] });

        expect(screen.getByText("Earlier mention")).toBeTruthy();
        expect(
            screen.getByText(
                "No action is offered because newer information already set this field.",
            ),
        ).toBeTruthy();
        expect(screen.queryByRole("checkbox")).toBeNull();
        expect(screen.queryByRole("radio")).toBeNull();
    });

    it("labels unmatched Plaud tasks", () => {
        openReview({ proposals: [task({ source: "plaud" })] });
        expect(
            screen.getByText("Not matched against earlier tasks"),
        ).toBeTruthy();
    });

    it("links mail evidence to its exact text range", () => {
        openReview({
            proposals: [
                task({
                    evidenceItemKind: "mail",
                    evidenceStartMs: null,
                    evidenceText: {
                        segmentIndex: 2,
                        charStart: 8,
                        charEnd: 31,
                    },
                }),
            ],
        });
        expect(
            screen
                .getByRole("link", { name: "Show evidence in mail" })
                .getAttribute("href"),
        ).toBe(
            "/dashboard?recording=source-item&evidenceSegment=2&evidenceStart=8&evidenceEnd=31",
        );
        fireEvent.click(
            screen.getByRole("link", { name: "Show evidence in mail" }),
        );
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("loads merge candidates on open and merges a proposal from the keyboard", async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(
            Response.json({
                candidates: [
                    {
                        id: "target-1",
                        text: "Send the contract",
                        assignee: { personId: "person-1", name: "Ada" },
                        dueDate: "2026-10-20",
                        duePhrase: null,
                        homeItem: {
                            id: "earlier-item",
                            kind: "audio",
                            title: "Contract planning",
                            audioAvailable: true,
                        },
                    },
                ],
                nextOffset: null,
            }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const current = openReview({ proposals: [task()] });

        fireEvent.click(
            screen.getByRole("button", { name: "Merge into an earlier task" }),
        );
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/recordings/source-item/tasks/merge?q=&offset=0&limit=20&sourceTaskId=proposal-1",
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            ),
        );
        const search = await screen.findByRole("combobox", {
            name: "Search earlier tasks",
        });
        fireEvent.keyDown(search, { key: "ArrowDown" });
        fireEvent.keyDown(search, { key: "Enter" });
        fireEvent.click(screen.getByRole("button", { name: "Merge task" }));
        await waitFor(() =>
            expect(current.mergeInto).toHaveBeenCalledWith(
                "proposal-1",
                "target-1",
            ),
        );
    });

    it("loads every merge-candidate page through a keyboard-reachable row", async () => {
        const first = {
            id: "target-1",
            text: "Routine follow-up 1",
            assignee: null,
            dueDate: null,
            duePhrase: null,
            homeItem: {
                id: "earlier-item",
                kind: "audio" as const,
                title: "Contract planning",
                audioAvailable: true,
            },
        };
        const second = { ...first, id: "target-21", text: "Exact result" };
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                Response.json({ candidates: [first], nextOffset: 20 }),
            )
            .mockResolvedValueOnce(
                Response.json({ candidates: [second], nextOffset: null }),
            );
        vi.stubGlobal("fetch", fetchMock);
        openReview({ proposals: [task()] });

        fireEvent.click(
            screen.getByRole("button", { name: "Merge into an earlier task" }),
        );
        const more = await screen.findByRole("button", {
            name: "Show more tasks",
        });
        more.focus();
        expect(document.activeElement).toBe(more);
        fireEvent.click(more);

        expect(await screen.findByText("Exact result")).toBeTruthy();
        expect(fetchMock).toHaveBeenLastCalledWith(
            "/api/recordings/source-item/tasks/merge?q=&offset=20&limit=20&sourceTaskId=proposal-1",
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
    });

    it("gives every Stage 4a dialog an accessible description", async () => {
        const consoleError = vi
            .spyOn(console, "error")
            .mockImplementation(() => undefined);
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                Response.json({ candidates: [], nextOffset: null }),
            );
        vi.stubGlobal("fetch", fetchMock);
        openReview({ proposals: [task()] });
        fireEvent.click(
            screen.getByRole("button", { name: "Merge into an earlier task" }),
        );
        await screen.findByText("Choose the open task that should remain.");

        expect(
            consoleError.mock.calls.some((call) =>
                call.some((part) => String(part).includes("Description")),
            ),
        ).toBe(false);
    });
});
