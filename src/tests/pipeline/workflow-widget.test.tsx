// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    openWidget,
    WorkflowWidget,
    WorkflowWidgetLine,
} from "@/components/pipeline/workflow-widget";
import { Button } from "@/components/ui/button";
import type {
    WorkflowWidgetFrame,
    WorkflowWidgetTone,
} from "@/lib/pipeline/workflow-widgets";

function ExampleWidget({ frame }: { frame: WorkflowWidgetFrame }) {
    const [open, setOpen] = useState(false);
    return (
        <WorkflowWidget
            id={`example-${frame}`}
            frame={frame}
            tone="review"
            open={open}
            onOpenChange={setOpen}
            title="Shared title"
            description="Shared description"
            headerAction={<Button>Header action</Button>}
            footer={{
                status: <span>Shared footer</span>,
                actions: <Button>Primary action</Button>,
            }}
            closeLabel="Save for later"
        >
            <p>Shared body</p>
        </WorkflowWidget>
    );
}

beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
    });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe.each([
    "inline",
    "dialog",
] as const)("WorkflowWidget %s frame", (frame) => {
    it("renders the shared heading, description, body, and footer", async () => {
        render(<ExampleWidget frame={frame} />);
        openWidget(`example-${frame}`);

        expect(
            await screen.findByRole("heading", { name: "Shared title" }),
        ).toBeTruthy();
        expect(screen.getByText("Shared description")).toBeTruthy();
        expect(screen.getByText("Shared body")).toBeTruthy();
        expect(screen.getByText("Shared footer")).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Primary action" }),
        ).toBeTruthy();
    });

    it("focuses its heading through openWidget", async () => {
        render(<ExampleWidget frame={frame} />);
        openWidget(`example-${frame}`);

        const heading = await screen.findByRole("heading", {
            name: "Shared title",
        });
        await waitFor(() => expect(document.activeElement).toBe(heading));
    });
});

it.each([
    ["quiet", "border-l-border"],
    ["next", "border-l-primary"],
    ["review", "border-l-[var(--step-review)]"],
    ["working", "border-l-[var(--step-working)]"],
] as const)("applies the %s tone", (tone: WorkflowWidgetTone, className) => {
    render(
        <WorkflowWidget
            id={`tone-${tone}`}
            frame="inline"
            tone={tone}
            title={tone}
        >
            body
        </WorkflowWidget>,
    );

    expect(
        document.querySelector("[data-workflow-widget]")?.className,
    ).toContain(className);
});

it("renders the close action only in the dialog frame", async () => {
    const inline = render(<ExampleWidget frame="inline" />);
    expect(screen.queryByRole("button", { name: "Save for later" })).toBeNull();
    inline.unmount();

    render(<ExampleWidget frame="dialog" />);
    openWidget("example-dialog");
    fireEvent.click(
        await screen.findByRole("button", { name: "Save for later" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("renders a compact line with one accessible expand control", () => {
    const onExpand = vi.fn();
    render(
        <WorkflowWidgetLine
            title="Transcription"
            facts="Riffado"
            expanded={false}
            onExpand={onExpand}
            expandLabel="View transcript"
        />,
    );

    const control = screen.getByRole("button", { name: "View transcript" });
    expect(control.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(control);
    expect(onExpand).toHaveBeenCalledOnce();
});
