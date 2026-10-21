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
    OPEN_WORKFLOW_WIDGET_EVENT,
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

function ReplacingWidget({
    frame,
    title,
}: {
    frame: WorkflowWidgetFrame;
    title: string;
}) {
    const [open, setOpen] = useState(false);
    return (
        <WorkflowWidget
            id="replacing-widget"
            frame={frame}
            tone="review"
            open={open}
            onOpenChange={setOpen}
            title={title}
        />
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
    vi.restoreAllMocks();
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

it("opens after replacing its host without resubscribing on rerender", async () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const view = render(<ReplacingWidget frame="inline" title="First title" />);
    const openSubscriptions = () =>
        addEventListener.mock.calls.filter(
            ([eventName]) => String(eventName) === OPEN_WORKFLOW_WIDGET_EVENT,
        );
    const openUnsubscriptions = () =>
        removeEventListener.mock.calls.filter(
            ([eventName]) => String(eventName) === OPEN_WORKFLOW_WIDGET_EVENT,
        );

    expect(openSubscriptions()).toHaveLength(1);
    view.rerender(<ReplacingWidget frame="inline" title="Second title" />);
    expect(openSubscriptions()).toHaveLength(1);
    expect(openUnsubscriptions()).toHaveLength(0);

    const previousHost = document.getElementById("replacing-widget");
    view.rerender(<ReplacingWidget frame="dialog" title="Dialog title" />);
    expect(document.getElementById("replacing-widget")).not.toBe(previousHost);
    openWidget("replacing-widget");

    expect(
        await screen.findByRole("dialog", { name: "Dialog title" }),
    ).toBeTruthy();
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

function CompactWidget() {
    const [expanded, setExpanded] = useState(false);
    return (
        <WorkflowWidget
            id="compact-widget"
            frame="inline"
            tone="quiet"
            title="Compact title"
            onOpenChange={setExpanded}
            inlineLine={expanded ? undefined : <p>Compact line</p>}
        >
            <p>Compact body</p>
        </WorkflowWidget>
    );
}

it("leaves the compact line and focuses the visible heading through openWidget", async () => {
    render(<CompactWidget />);
    expect(screen.getByText("Compact line")).toBeTruthy();
    openWidget("compact-widget");

    const heading = await screen.findByRole("heading", {
        name: "Compact title",
    });
    expect(heading.closest("[hidden]")).toBeNull();
    expect(screen.queryByText("Compact line")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(heading));
});

it("keeps body state mounted while collapsed or replaced by a compact line", () => {
    const contents = (collapsed: boolean, compact: boolean) => (
        <WorkflowWidget
            id="preserved"
            frame="inline"
            tone="quiet"
            title="Preserved title"
            description="Hidden description"
            collapsed={collapsed}
            inlineLine={compact ? <p>Compact line</p> : undefined}
            headerAction={<button type="button">Header action</button>}
            footer={{ status: "Footer status", actions: null }}
        >
            <input aria-label="Pending answer" defaultValue="" />
        </WorkflowWidget>
    );
    const rendered = render(contents(false, false));
    const input = screen.getByRole("textbox", { name: "Pending answer" });
    fireEvent.change(input, { target: { value: "Unfinished answer" } });
    rendered.rerender(contents(true, false));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText("Hidden description")).toBeNull();
    expect(screen.getByText("Footer status").closest("[hidden]")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Header action" })).toBeTruthy();
    rendered.rerender(contents(true, true));
    expect(screen.getByText("Compact line")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Header action" })).toBeNull();
    rendered.rerender(contents(false, false));
    expect(screen.getByRole("textbox", { name: "Pending answer" })).toBe(input);
    expect(input).toHaveProperty("value", "Unfinished answer");
    expect(screen.getByText("Footer status").closest("[hidden]")).toBeNull();
});
