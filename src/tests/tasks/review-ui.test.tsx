// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { RecordingTasks as RecordingTasksList } from "@/components/tasks/recording-tasks";
import { TaskReviewLink } from "@/components/tasks/task-review-dialog";
import type { RecordingTasksState } from "@/components/tasks/use-recording-tasks";
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
        status: "proposed",
        text: "Send the revised contract",
        assignee: { personId: "person-1", name: "Ada" },
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
            },
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
        add: vi.fn(async () => {}),
        merge: vi.fn(async () => true),
        mergeInto: vi.fn(async () => true),
        undoMatch: vi.fn(async () => {}),
        tickUpdate: vi.fn(),
        tickMatch: vi.fn(),
        accept: vi.fn(async () => true),
    };
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

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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

        expect(screen.getByRole("checkbox", { name: "Done" })).toHaveProperty(
            "disabled",
            true,
        );
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

    it("shows an unticked suggested match with its candidate and evidence", () => {
        const onPlay = vi.fn();
        const current = state({
            canEdit: true,
            reviewed: false,
            tasks: [],
            proposals: [],
            updates: [],
            matches: [match()],
        });
        render(
            <TaskReviewLink
                state={current}
                speakers={[]}
                organizationOnly={false}
                onPlay={onPlay}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: /Review tasks/ }));

        expect(screen.getByText("Suggested match")).toBeTruthy();
        expect(screen.getByText("Send the contract")).toBeTruthy();
        expect(screen.getByText(/Ada/)).toBeTruthy();
        expect(screen.getByText(/2026-10-20/)).toBeTruthy();
        expect(screen.getByText(/Contract planning/)).toBeTruthy();
        expect(
            screen.getByRole("checkbox", {
                name: "Apply suggested match to Send the contract",
            }),
        ).toHaveProperty("checked", false);
        fireEvent.click(screen.getByRole("button", { name: "Play evidence" }));
        expect(onPlay).toHaveBeenCalledWith(12_500);
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
        expect(screen.getByText("Suggested match")).toBeTruthy();
        expect(screen.getByText("Current deadline")).toBeTruthy();
        expect(screen.getByText("Earlier mention")).toBeTruthy();
        expect(screen.queryByText("Heard about earlier tasks")).toBeNull();
        expect(screen.getByText("0 of 1 will be accepted")).toBeTruthy();

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
