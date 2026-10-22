// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RecordingTasks } from "@/components/tasks/recording-tasks";
import { TaskReviewLink } from "@/components/tasks/task-review-dialog";
import { TaskRow } from "@/components/tasks/task-row";
import type { RecordingTasksState } from "@/components/tasks/use-recording-tasks";
import type { TaskView } from "@/lib/tasks/tasks";

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
