// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskRequestError } from "@/components/tasks/task-api";
import { showTaskMergeFailure } from "@/components/tasks/task-list";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("sonner", () => ({
    toast: { error: toastError, success: vi.fn() },
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
