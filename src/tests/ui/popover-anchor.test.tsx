// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { ActionTooltip, TooltipProvider } from "@/components/ui/tooltip";

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

it("opens below its trigger when a tooltip wraps the trigger", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        top: 80,
        bottom: 100,
        left: 460,
        right: 500,
        width: 40,
        height: 20,
        x: 460,
        y: 80,
        toJSON: () => ({}),
    });
    render(
        <TooltipProvider>
            <Popover>
                <ActionTooltip label="Copy link">
                    <PopoverTrigger asChild>
                        <Button aria-label="Copy link">Copy</Button>
                    </PopoverTrigger>
                </ActionTooltip>
                <PopoverContent title="Copy link">Options</PopoverContent>
            </Popover>
        </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    const content = screen.getByRole("dialog", { name: "Copy link" });
    expect(content.style.top).toBe("108px");
    expect(content.style.right).toBe(`${window.innerWidth - 500}px`);
});

it("passes the trigger to a callback ref and runs its cleanup on unmount", () => {
    const cleanup = vi.fn();
    const ref = vi.fn(() => cleanup);
    const { unmount } = render(
        <Popover>
            <PopoverTrigger ref={ref}>Open</PopoverTrigger>
        </Popover>,
    );
    expect(ref).toHaveBeenCalledWith(screen.getByRole("button"));
    unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
});

it("clears an object ref when the trigger unmounts", () => {
    const ref = { current: null as HTMLButtonElement | null };
    const { unmount } = render(
        <Popover>
            <PopoverTrigger ref={ref}>Open</PopoverTrigger>
        </Popover>,
    );
    expect(ref.current).toBe(screen.getByRole("button"));
    unmount();
    expect(ref.current).toBeNull();
});
