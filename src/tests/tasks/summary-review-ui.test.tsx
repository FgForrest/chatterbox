// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingTasks } from "@/components/tasks/recording-tasks";
import { TaskReviewLink } from "@/components/tasks/task-review-dialog";
import { TaskRow } from "@/components/tasks/task-row";
import type { RecordingTasksState } from "@/components/tasks/use-recording-tasks";
import type {
    RecordingTasks as RecordingTasksData,
    TaskView,
} from "@/lib/tasks/tasks";

vi.mock("next-intl", () => ({
    useExtracted: () => (text: string, values?: Record<string, unknown>) =>
        text.replace(/\{(\w+)\}/g, (_match, key: string) =>
            String(values?.[key] ?? ""),
        ),
    useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
}));

afterEach(async () => {
    cleanup();
    await act(async () => {});
});

const task: TaskView = {
    id: "task-1",
    recordingId: "item-1",
    evidenceItemId: "item-1",
    evidenceItemKind: "audio",
    status: "open",
    text: "Send the contract",
    assignee: null,
    assigneeHasEmail: false,
    assigneeHint: "Zava",
    assigneeCheck: true,
    dueDate: null,
    duePhrase: null,
    quote: null,
    evidenceStartMs: null,
    evidenceAudioAvailable: true,
    evidenceText: null,
    evidenceProvenance: null,
    source: "riffado",
    ticked: true,
    version: 1,
    createdAt: "2026-10-21T10:00:00Z",
    acceptedAt: "2026-10-21T10:00:00Z",
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
};

it("offers Review tasks and applies the owner-selected proposals", async () => {
    const state: RecordingTasksState = {
        itemId: "item-1",
        data: {
            canEdit: true,
            reviewed: false,
            tasks: [],
            proposals: [
                { ...task, status: "proposed", acceptedAt: null, version: 0 },
            ],
            updates: [],
            matches: [],
        },
        failed: false,
        reviewing: true,
        waiting: 1,
        accepting: false,
        update: vi.fn(),
        add: vi.fn(async () => null),
        merge: vi.fn(async () => false),
        mergeInto: vi.fn(async () => false),
        undoMatch: vi.fn(async () => {}),
        tickUpdate: vi.fn(),
        tickMatch: vi.fn(),
        accept: vi.fn(async () => false),
    };
    render(
        <TaskReviewLink state={state} speakers={[]} organizationOnly={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Review tasks/ }));
    fireEvent.click(
        screen.getByRole("button", { name: /Apply selected changes/ }),
    );
    await waitFor(() => expect(state.accept).toHaveBeenCalledOnce());
});

it("shows who is this beside the heard name and lets the owner choose a person", async () => {
    const onChange = vi.fn();
    render(
        <TaskRow
            task={task}
            speakers={[{ personId: "zava-full", name: "Zava Noren" }]}
            organizationOnly={false}
            onChange={onChange}
        />,
    );
    expect(screen.getByText("who is this?")).toBeTruthy();
    const picker = screen.getByRole("button", { name: "Assigned to Zava" });
    expect(picker.textContent).toContain("Zava");
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    fireEvent.click(
        await screen.findByRole("menuitem", { name: /Zava Noren/ }),
    );
    await waitFor(() => expect(document.activeElement).toBe(picker));
    expect(onChange).toHaveBeenCalledWith(
        { assigneePersonId: "zava-full" },
        {
            assignee: { personId: "zava-full", name: "Zava Noren" },
            assigneeHint: null,
            assigneeCheck: false,
        },
    );
});

it("suppresses the summary fallback when proposals are hidden from a colleague", () => {
    render(
        <RecordingTasks
            state={{
                data: {
                    canEdit: false,
                    reviewed: true,
                    tasks: [],
                    proposals: [],
                    updates: [],
                    matches: [],
                },
                itemId: "item-1",
                reviewing: false,
                failed: false,
                waiting: 0,
                accepting: false,
                update: vi.fn(),
                add: vi.fn(async () => null),
                merge: vi.fn(async () => false),
                mergeInto: vi.fn(async () => false),
                undoMatch: vi.fn(async () => {}),
                tickUpdate: vi.fn(),
                tickMatch: vi.fn(),
                accept: vi.fn(async () => false),
            }}
            speakers={[]}
            organizationOnly={true}
            fallback={<p>Unreviewed summary task</p>}
        />,
    );
    expect(screen.queryByText("Unreviewed summary task")).toBeNull();
});

function reviewState(
    overrides: Partial<RecordingTasksState> = {},
): RecordingTasksState & { data: RecordingTasksData } {
    const state: RecordingTasksState = {
        itemId: "item-1",
        data: {
            canEdit: true,
            reviewed: false,
            tasks: [],
            proposals: [{ ...task, status: "proposed", version: 0 }],
            updates: [],
            matches: [],
            taskReviewChanged: false,
            taskReviewSkipped: false,
        },
        failed: false,
        reviewing: true,
        waiting: 1,
        accepting: false,
        update: vi.fn(),
        add: vi.fn(async () => null),
        merge: vi.fn(async () => false),
        mergeInto: vi.fn(async () => false),
        undoMatch: vi.fn(async () => {}),
        tickUpdate: vi.fn(),
        tickMatch: vi.fn(),
        accept: vi.fn(async () => true),
        skip: vi.fn(),
        touch: vi.fn(),
        ...overrides,
    };
    if (!state.data) throw new Error("No review fixture");
    return { ...state, data: state.data };
}

describe.each([
    "inline",
    "dialog",
] as const)("quick task review in the %s frame", (frame) => {
    async function open(current: RecordingTasksState) {
        const view = render(
            <TaskReviewLink
                state={current}
                speakers={[]}
                organizationOnly={false}
                frame={frame}
                showTrigger={false}
            />,
        );
        if (frame === "dialog")
            fireEvent.click(
                await screen.findByRole("button", { name: "Review" }),
            );
        return view;
    }
    it("offers Skip only until the server draft is changed", async () => {
        const current = reviewState();
        const view = await open(current);
        fireEvent.click(screen.getByRole("button", { name: "Skip" }));
        expect(current.skip).toHaveBeenCalledOnce();
        const edited = {
            ...current,
            data: { ...current.data, taskReviewChanged: true },
        };
        view.rerender(
            <TaskReviewLink
                state={edited}
                speakers={[]}
                organizationOnly={false}
                frame={frame}
                showTrigger={false}
            />,
        );
        expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
        expect(
            screen.getByRole("button", { name: "Apply selected changes" }),
        ).toBeTruthy();
    });
    it("ticks the Tasks group, shows its mixed state, and offers Finish without tasks", async () => {
        const current = reviewState();
        current.data.proposals.push({
            ...current.data.proposals[0],
            id: "second",
            ticked: false,
        });
        current.waiting = 2;
        const view = await open(current);
        const group = screen.getByRole("checkbox", {
            name: "Tick all: Tasks",
        }) as HTMLInputElement;
        expect(group.indeterminate).toBe(true);
        expect(screen.getByText("1 of 2 selected")).toBeTruthy();
        fireEvent.click(group);
        expect(current.update).toHaveBeenCalledWith(
            current.data.proposals[1],
            { ticked: true },
            { ticked: true },
        );
        const none = {
            ...current,
            data: {
                ...current.data,
                proposals: current.data.proposals.map((row) => ({
                    ...row,
                    ticked: false,
                })),
            },
        };
        view.rerender(
            <TaskReviewLink
                state={none}
                speakers={[]}
                organizationOnly={false}
                frame={frame}
                showTrigger={false}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Finish without tasks" }),
        );
        expect(current.accept).toHaveBeenCalledOnce();
        expect(
            screen.getByRole("contentinfo").classList.contains("sticky"),
        ).toBe(frame === "inline");
    });
    it("remembers a text edit before blur", async () => {
        const current = reviewState();
        await open(current);
        fireEvent.change(screen.getByRole("textbox", { name: "Task" }), {
            target: { value: "Changed draft" },
        });
        expect(current.touch).toHaveBeenCalledOnce();
    });
});

it.each([
    false,
    true,
])("opens skipped proposals next to task controls (accepted tasks: %s), keeps them when closed, and hides them after Finish", async (hasTasks) => {
    const current = reviewState({ reviewing: false });
    current.data.taskReviewSkipped = true;
    current.data.reviewed = true;
    if (hasTasks) current.data.tasks = [task];
    const view = render(
        <RecordingTasks
            state={current}
            speakers={[]}
            organizationOnly={false}
            fallback={<p>Fallback</p>}
        />,
    );
    expect(screen.queryByText("Fallback")).toBeNull();
    fireEvent.click(
        screen.getByRole("button", { name: "Skipped proposals (1)" }),
    );
    expect(
        await screen.findByRole("dialog", { name: "Task review" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    fireEvent.click(
        screen.getByRole("button", { name: "Save and continue later" }),
    );
    expect(current.accept).not.toHaveBeenCalled();
    fireEvent.click(
        screen.getByRole("button", { name: "Skipped proposals (1)" }),
    );
    fireEvent.click(
        screen.getByRole("button", { name: "Apply selected changes" }),
    );
    expect(current.accept).toHaveBeenCalledOnce();
    const finished = {
        ...current,
        waiting: 0,
        data: { ...current.data, proposals: [], taskReviewSkipped: false },
    };
    view.rerender(
        <RecordingTasks
            state={finished}
            speakers={[]}
            organizationOnly={false}
            fallback={null}
        />,
    );
    expect(
        screen.queryByRole("button", { name: /Skipped proposals/ }),
    ).toBeNull();
});

it("keeps skipped proposals private to the reviewer", () => {
    const current = reviewState({ reviewing: false });
    current.data.canEdit = false;
    current.data.taskReviewSkipped = true;
    render(
        <RecordingTasks
            state={current}
            speakers={[]}
            organizationOnly={true}
            fallback={null}
        />,
    );
    expect(
        screen.queryByRole("button", { name: /Skipped proposals/ }),
    ).toBeNull();
});

it("keeps deferred proposals out of the summary fallback during Undo", () => {
    const current = reviewState({ reviewing: false });
    render(
        <>
            <TaskReviewLink
                state={current}
                speakers={[]}
                organizationOnly={false}
                frame="inline"
            />
            <RecordingTasks
                state={current}
                speakers={[]}
                organizationOnly={false}
                fallback={<p>Unreviewed summary task</p>}
            />
        </>,
    );
    expect(screen.queryByText("Unreviewed summary task")).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add task" })).toBeTruthy();
});
