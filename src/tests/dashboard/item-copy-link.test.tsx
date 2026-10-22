// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemHeader } from "@/components/items/item-header";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({
    writeText: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
}));
vi.mock("sonner", () => ({
    toast: { success: mocks.success, error: mocks.error },
}));
vi.mock("@/components/recordings/ai-cost-summary", () => ({
    AiCostSummary: () => null,
}));
vi.mock("@/components/recordings/recording-title", () => ({
    RecordingTitle: ({ filename }: { filename: string }) => (
        <span>{filename}</span>
    ),
}));

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    mocks.writeText.mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: mocks.writeText } });
    window.history.replaceState(
        {},
        "",
        "/dashboard?recording=old&playFrom=165980&evidenceStart=4",
    );
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/");
});

describe.each(["audio", "mail"] as const)("%s item copy link", (kind) => {
    it.each([
        "private",
        "org",
    ] as const)("copies the absolute %s URL without playback or evidence", async (view) => {
        render(
            <TooltipProvider>
                <ItemHeader
                    itemId="item with spaces"
                    kind={kind}
                    title="Item"
                    metadata={[]}
                    view={view}
                />
            </TooltipProvider>,
        );
        fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
        await waitFor(() =>
            expect(mocks.success).toHaveBeenCalledExactlyOnceWith(
                view === "org"
                    ? "Link copied. Other members of your Organization can open it."
                    : "Link copied. Only you can open it.",
            ),
        );
        expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith(
            `${window.location.origin}/dashboard?recording=item+with+spaces${view === "org" ? "&view=org" : ""}`,
        );
        expect(mocks.error).not.toHaveBeenCalled();
    });
});

it("tells the owner of a shared item that Organization members can open its private-view link", async () => {
    render(
        <TooltipProvider>
            <ItemHeader
                itemId="item"
                kind="audio"
                title="Item"
                metadata={[]}
                view="private"
                shared
            />
        </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() =>
        expect(mocks.success).toHaveBeenCalledExactlyOnceWith(
            "Link copied. Other members of your Organization can open it.",
        ),
    );
    expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith(
        `${window.location.origin}/dashboard?recording=item`,
    );
});

it("exposes the Copy link tooltip", async () => {
    render(
        <TooltipProvider>
            <ItemHeader itemId="item" kind="audio" title="Item" metadata={[]} />
        </TooltipProvider>,
    );
    fireEvent.focus(screen.getByRole("button", { name: "Copy link" }));
    expect(
        await screen.findByRole("tooltip", { name: "Copy link" }),
    ).toBeTruthy();
});

it.each([
    "rejected",
    "unavailable",
])("reports %s clipboard access", async (failure) => {
    if (failure === "rejected")
        mocks.writeText.mockRejectedValue(new Error("Denied"));
    else vi.stubGlobal("navigator", {});
    render(
        <TooltipProvider>
            <ItemHeader itemId="item" kind="mail" title="Item" metadata={[]} />
        </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() =>
        expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
            "Could not copy the link. Try again.",
        ),
    );
    expect(mocks.success).not.toHaveBeenCalled();
});
