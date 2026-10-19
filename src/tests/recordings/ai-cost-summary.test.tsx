// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemHeader } from "@/components/items/item-header";
import { AiCostSummary } from "@/components/recordings/ai-cost-summary";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("next-intl", () => ({
    useExtracted: () => (message: string) => message,
}));

vi.mock("@/components/recordings/recording-title", () => ({
    RecordingTitle: ({ filename }: { filename: string }) => (
        <span>{filename}</span>
    ),
}));

const emptySummary = {
    totalUsd: 0,
    byOperation: {},
    byService: {},
    unknownByService: {},
    unknownCount: 0,
    requestCount: 0,
};

const pricedSummary = {
    totalUsd: 0.45,
    byOperation: { summary: 0.3, title: 0.15 },
    byService: { "Codex · model": 0.45 },
    unknownByService: {},
    unknownCount: 0,
    requestCount: 2,
};

function mockSummary(summary: typeof emptySummary = pricedSummary) {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(summary));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

function renderSummary(
    props: Partial<ComponentProps<typeof AiCostSummary>> = {},
) {
    return render(
        <TooltipProvider>
            <AiCostSummary recordingId="item-1" {...props} />
        </TooltipProvider>,
    );
}

function openBreakdown(trigger: HTMLElement) {
    fireEvent.pointerDown(trigger, {
        button: 0,
        ctrlKey: false,
        pointerType: "mouse",
    });
    fireEvent.pointerUp(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger);
    return screen.findByRole("dialog", { name: /^Estimated AI spend/ });
}

beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("AI cost summary", () => {
    it.each([
        ["audio", "recording", "focus"],
        ["mail", "mail", "focus"],
        ["audio", "recording", "hover"],
        ["mail", "mail", "hover"],
    ] as const)("shows the %s empty tooltip for a %s on %s", async (kind, noun, interaction) => {
        mockSummary(emptySummary);
        renderSummary({ kind });
        const text = `No AI spend tracked for this ${noun}`;
        const trigger = await screen.findByRole("button", { name: text });
        expect(trigger.textContent).toBe("$??");
        expect(trigger.querySelector("svg")).toBeNull();
        expect(trigger.hasAttribute("aria-haspopup")).toBe(false);
        expect(screen.queryByText(text)).toBeNull();
        if (interaction === "focus") act(() => trigger.focus());
        else fireEvent.pointerMove(trigger, { pointerType: "mouse" });
        expect((await screen.findByRole("tooltip")).textContent).toBe(text);
        if (interaction === "focus")
            expect(document.activeElement).toBe(trigger);
    });

    it("opens the labeled priced breakdown on click and closes on Escape", async () => {
        mockSummary();
        const { container } = renderSummary();
        const trigger = await screen.findByRole("button", {
            name: "Estimated AI spend: $0.45",
        });
        expect(trigger.textContent).toBe("$0.45");
        expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
        expect(trigger.querySelector("svg.lucide-chevron-down")).toBeTruthy();
        expect(screen.queryByRole("dialog")).toBeNull();
        const panel = await openBreakdown(trigger);
        expect(panel.hasAttribute("aria-orientation")).toBe(false);
        expect(container.contains(panel)).toBe(false);
        expect(panel.firstElementChild?.textContent).toBe(
            "Estimated AI spend: $0.45",
        );
        expect(
            within(panel).getByText("summary").parentElement?.textContent,
        ).toBe("summary$0.30");
        expect(
            within(panel).getByText("title").parentElement?.textContent,
        ).toBe("title$0.15");
        expect(
            within(panel).getByText("Codex · model").parentElement?.textContent,
        ).toBe("Codex · model$0.45");
        expect(
            within(panel).getByText(
                "Claude Code and Codex amounts estimate equivalent API usage, not subscription charges.",
            ),
        ).toBeTruthy();
        fireEvent.keyDown(panel, { key: "Escape" });
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        await waitFor(() => expect(document.activeElement).toBe(trigger));
    });

    it.each(["Enter", " "])("opens with the %s key", async (key) => {
        mockSummary();
        renderSummary();
        const trigger = await screen.findByRole("button", {
            name: "Estimated AI spend: $0.45",
        });
        act(() => trigger.focus());
        fireEvent.keyDown(trigger, { key });
        expect(await screen.findByRole("dialog")).toBeTruthy();
    });

    it("closes on an outside click", async () => {
        mockSummary();
        renderSummary();
        const trigger = await screen.findByRole("button", {
            name: "Estimated AI spend: $0.45",
        });
        await openBreakdown(trigger);
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        fireEvent.pointerDown(document.body, { pointerType: "mouse" });
        fireEvent.click(document.body);
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("appends + ? for partially unpriced requests and preserves the notes", async () => {
        mockSummary({
            ...pricedSummary,
            unknownByService: { "Claude Code · model": 1 },
            unknownCount: 1,
            requestCount: 3,
        });
        renderSummary();
        const trigger = await screen.findByRole("button", {
            name: "Estimated AI spend: $0.45",
        });
        expect(trigger.textContent).toBe("$0.45 + ?");
        const panel = await openBreakdown(trigger);
        expect(within(panel).getByText("1 unpriced")).toBeTruthy();
        expect(within(panel).getByText("Claude Code · model")).toBeTruthy();
        expect(
            within(panel).getByText(
                "Some requests lack usable cost data; the total is incomplete.",
            ),
        ).toBeTruthy();
        expect(
            within(panel).getByText(
                "Claude Code and Codex amounts estimate equivalent API usage, not subscription charges.",
            ),
        ).toBeTruthy();
    });

    it("shows $?? with a chevron and unpriced services when all requests are unpriced", async () => {
        mockSummary({
            ...emptySummary,
            unknownByService: { "Local AI": 2 },
            unknownCount: 2,
            requestCount: 2,
        });
        renderSummary();
        const trigger = await screen.findByRole("button", {
            name: "Estimated AI spend: $??",
        });
        expect(trigger.textContent).toBe("$??");
        expect(trigger.querySelector("svg.lucide-chevron-down")).toBeTruthy();
        const panel = await openBreakdown(trigger);
        expect(within(panel).getByText("Estimated AI spend: $??")).toBeTruthy();
        expect(within(panel).getByText("Local AI")).toBeTruthy();
        expect(within(panel).getByText("2 unpriced")).toBeTruthy();
    });

    it("keeps a priced zero total distinct from missing prices", async () => {
        mockSummary({
            ...emptySummary,
            byService: { "Local AI": 0 },
            requestCount: 1,
        });
        renderSummary();
        expect(
            await screen.findByRole("button", {
                name: "Estimated AI spend: $0.00",
            }),
        ).toBeTruthy();
    });

    it("renders nothing until the fetch resolves", async () => {
        let resolveFetch: ((response: Response) => void) | undefined;
        vi.stubGlobal(
            "fetch",
            vi.fn(
                () =>
                    new Promise<Response>((resolve) => {
                        resolveFetch = resolve;
                    }),
            ),
        );
        const { container } = renderSummary();
        expect(container.childElementCount).toBe(0);
        await act(async () => {
            resolveFetch?.(Response.json(pricedSummary));
        });
        expect(
            await screen.findByRole("button", {
                name: "Estimated AI spend: $0.45",
            }),
        ).toBeTruthy();
    });

    it.each([
        "http",
        "network",
        "json",
    ])("renders nothing after a %s failure", async (failure) => {
        const fetchMock = vi.fn();
        if (failure === "http")
            fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
        else if (failure === "network")
            fetchMock.mockRejectedValue(new Error("offline"));
        else fetchMock.mockResolvedValue(new Response("invalid json"));
        vi.stubGlobal("fetch", fetchMock);
        const { container } = renderSummary();
        await act(async () => {});
        expect(container.childElementCount).toBe(0);
    });

    it("polls every 30 seconds with the view parameter and keeps the last spend on failure", async () => {
        vi.useFakeTimers();
        const fetchMock = mockSummary();
        const { container, unmount } = renderSummary({
            recordingId: "item/1",
            view: "org",
        });
        await act(async () => {});
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/recordings/item%2F1/ai-cost?view=org",
        );
        expect(container.querySelector("button")?.textContent).toBe("$0.45");
        fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(29_999);
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(container.querySelector("button")?.textContent).toBe("$0.45");
        unmount();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("header metadata spend", () => {
    it.each([
        { metadata: [], view: "private", state: "loaded" },
        { metadata: [], view: "org", state: "loaded" },
        {
            metadata: ["5 minutes ago", "23:37", "21.73 MB"],
            view: "private",
            state: "loaded",
        },
        {
            metadata: ["5 minutes ago", "23:37", "21.73 MB"],
            view: "org",
            state: "loaded",
        },
        { metadata: [], view: "private", state: "loading" },
        { metadata: [], view: "org", state: "loading" },
        { metadata: ["21.73 MB"], view: "private", state: "loading" },
        { metadata: ["21.73 MB"], view: "org", state: "loading" },
        { metadata: [], view: "org", state: "failed" },
        { metadata: ["21.73 MB"], view: "org", state: "failed" },
    ] as const)("separates visible items for $view with $state spend and $metadata", async ({
        metadata,
        view,
        state,
    }) => {
        if (state === "loaded") mockSummary();
        else if (state === "failed")
            vi.stubGlobal(
                "fetch",
                vi.fn().mockRejectedValue(new Error("offline")),
            );
        else
            vi.stubGlobal(
                "fetch",
                vi.fn(() => new Promise<Response>(() => {})),
            );
        const { container } = render(
            <TooltipProvider>
                <ItemHeader
                    itemId="item-1"
                    kind="audio"
                    title="Recording"
                    metadata={[...metadata]}
                    view={view}
                />
            </TooltipProvider>,
        );
        await act(async () => {});
        const row = container.querySelector('[data-slot="item-metadata"]');
        expect(row).toBeTruthy();
        if (!row) throw new Error("Expected metadata row");
        expect(row.className).toContain("flex-wrap");
        expect(row.className).toContain("text-sm text-muted-foreground");
        expect(row.className).toContain(
            "[&>span:first-child>[data-slot=metadata-separator]]:hidden",
        );
        const items = Array.from(row.children);
        const expectedItems =
            metadata.length +
            Number(state === "loaded") +
            Number(view === "org");
        expect(items).toHaveLength(expectedItems);
        const visibleSeparators = row.querySelectorAll(
            ':scope > span:not(:first-child) > [data-slot="metadata-separator"]',
        );
        expect(visibleSeparators).toHaveLength(Math.max(0, expectedItems - 1));
        for (const separator of visibleSeparators) {
            expect(separator.textContent).toBe("·");
            expect(separator.getAttribute("aria-hidden")).toBe("true");
            expect(separator.className).toBe("opacity-40");
        }
        if (state === "loaded") {
            const trigger = screen.getByRole("button", {
                name: "Estimated AI spend: $0.45",
            });
            const spendItem = items[metadata.length];
            expect(spendItem.contains(trigger)).toBe(true);
            expect(spendItem.className).toContain("shrink-0");
            expect(spendItem.className).toContain("whitespace-nowrap");
        } else
            expect(
                screen.queryByRole("button", { name: /Estimated AI spend/ }),
            ).toBeNull();
        if (view === "org")
            expect(
                items.at(-1)?.contains(screen.getByLabelText("Organization")),
            ).toBe(true);
    });

    it("remounts the summary when switching item or view", async () => {
        const fetchMock = mockSummary();
        const header = (itemId: string, view: "private" | "org") => (
            <TooltipProvider>
                <ItemHeader
                    itemId={itemId}
                    view={view}
                    kind="audio"
                    title="Recording"
                    metadata={[]}
                />
            </TooltipProvider>
        );
        const { rerender } = render(header("item-1", "private"));
        await screen.findByRole("button", {
            name: "Estimated AI spend: $0.45",
        });
        fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
        rerender(header("item-1", "org"));
        expect(
            screen.queryByRole("button", { name: /Estimated AI spend/ }),
        ).toBeNull();
        expect(fetchMock).toHaveBeenLastCalledWith(
            "/api/recordings/item-1/ai-cost?view=org",
        );
        rerender(header("item-2", "org"));
        expect(
            screen.queryByRole("button", { name: /Estimated AI spend/ }),
        ).toBeNull();
        expect(fetchMock).toHaveBeenLastCalledWith(
            "/api/recordings/item-2/ai-cost?view=org",
        );
    });
});
