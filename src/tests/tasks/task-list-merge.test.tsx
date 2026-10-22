// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskRequestError } from "@/components/tasks/task-api";
import { showTaskMergeFailure } from "@/components/tasks/task-list";
import { TaskRow } from "@/components/tasks/task-row";
import type { TaskListItem, TaskView } from "@/lib/tasks/tasks";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("sonner", () => ({
    toast: { error: toastError, success: vi.fn() },
}));
vi.mock("next-intl", () => ({
    useExtracted: () => (text: string) => text,
    useFormatter: () => ({
        dateTime: (value: Date) => value.toISOString().slice(0, 10),
    }),
}));

afterEach(() => {
    cleanup();
    toastError.mockReset();
});

it("shows a refused Organization-to-private merge rule as a toast", () => {
    function RefusedMerge() {
        return (
            <button
                type="button"
                onClick={() =>
                    showTaskMergeFailure(
                        new TaskRequestError(
                            "Merge rule: an Organization task can be merged only into an Organization task",
                            false,
                            403,
                        ),
                        {
                            visible: "visible",
                            open: "open",
                            organization:
                                "Merge rule: an Organization task can only join another Organization task.",
                            curator: "curator",
                            ownerOrCurator: "owner or curator",
                            owner: "owner",
                            shareFirst: "share first",
                            fallback: "Could not merge the tasks",
                        },
                    )
                }
            >
                Merge task
            </button>
        );
    }

    render(<RefusedMerge />);
    fireEvent.click(screen.getByRole("button", { name: "Merge task" }));

    expect(toastError).toHaveBeenCalledWith(
        "Merge rule: an Organization task can only join another Organization task.",
    );
});

it("links and labels a task with its evidence item metadata", () => {
    const task: TaskView = {
        id: "task-1",
        recordingId: "home-item",
        evidenceItemId: "evidence-item",
        evidenceItemKind: "audio",
        evidenceAudioAvailable: true,
        status: "open",
        text: "Follow up",
        assignee: null,
        assigneeHasEmail: false,
        assigneeHint: null,
        assigneeCheck: false,
        dueDate: null,
        duePhrase: null,
        quote: null,
        evidenceStartMs: 2_500,
        evidenceText: null,
        evidenceProvenance: null,
        source: "manual",
        ticked: true,
        version: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
        acceptedAt: null,
        statusChangedAt: null,
        canEdit: false,
        canClose: false,
        canUndoMatch: false,
    };
    const recording: TaskListItem["recording"] = {
        id: "home-item",
        title: "Home item",
        startTime: "2026-10-01T00:00:00.000Z",
        view: "private",
        kind: "audio",
    };
    const evidence: TaskListItem["evidence"] = {
        audioAvailable: true,
        id: "evidence-item",
        title: "Latest evidence",
        startTime: "2026-10-15T00:00:00.000Z",
        view: "org",
        kind: "audio",
    };

    render(
        <TaskRow
            task={task}
            recording={recording}
            evidence={evidence}
            organizationOnly={false}
            onChange={vi.fn()}
        />,
    );

    expect(screen.queryByText("Home item")).toBeNull();
    expect(screen.getByText("2026-10-15")).toBeTruthy();
    expect(
        screen
            .getByRole("link", { name: "Latest evidence" })
            .getAttribute("href"),
    ).toBe("/dashboard?recording=evidence-item&view=org&playFrom=2500");
});
