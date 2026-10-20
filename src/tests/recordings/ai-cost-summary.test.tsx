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
import type { AiCostPayer, recordingAiCost } from "@/lib/ai/usage-cost";

type CostSummary = Awaited<ReturnType<typeof recordingAiCost>>;

vi.mock("next-intl", () => ({
    useExtracted: () => (message: string, values?: Record<string, string>) =>
        message.replace(
            /\{(\w+)\}/g,
            (match, key: string) => values?.[key] ?? match,
        ),
}));

vi.mock("@/components/recordings/recording-title", () => ({
    RecordingTitle: ({ filename }: { filename: string }) => (
        <span>{filename}</span>
    ),
}));

const emptySummary: CostSummary = {
    totalUsd: 0,
    byOperation: {},
    byService: {},
    unknownByService: {},
    unknownCount: 0,
    requestCount: 0,
    payers: [],
};

const pricedSummary: CostSummary = {
    totalUsd: 0.45,
    byOperation: { summary: 0.3, title: 0.15 },
    byService: { "Codex · model": 0.45 },
    unknownByService: {},
    unknownCount: 0,
    requestCount: 2,
    payers: [
        {
            payer: { type: "organization" },
            byOperation: { summary: 0.3, title: 0.15 },
            byService: { "Codex · model": 0.45 },
            unknownByService: {},
        },
    ],
};

function mockSummary(summary: CostSummary = pricedSummary) {
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
        "private",
        "org",
    ] as const)("renders nothing in %s view when no AI usage is tracked", async (view) => {
        const fetchMock = mockSummary(emptySummary);
        const { container } = renderSummary({ view });
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        await act(async () => {});
        expect(screen.queryByRole("button")).toBeNull();
        expect(container.textContent).toBe("");
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
            within(panel).getByText("Summary").parentElement?.textContent,
        ).toBe("Summary$0.30");
        expect(
            within(panel).getByText("Title").parentElement?.textContent,
        ).toBe("Title$0.15");
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

    it.each([
        ["audio", "private"],
        ["audio", "org"],
        ["mail", "private"],
        ["mail", "org"],
    ] as const)("names the single Organization payer once for %s in %s view", async (_kind, view) => {
        mockSummary();
        renderSummary({ view });
        const trigger = await screen.findByRole("button", {
            name: "Estimated AI spend: $0.45",
        });
        const panel = await openBreakdown(trigger);
        expect(
            within(panel).getAllByText("Paid by the Organization."),
        ).toHaveLength(1);
        expect(within(panel).queryByText("· Organization")).toBeNull();
        expect(
            within(panel).getByText("Codex · model").parentElement?.textContent,
        ).toBe("Codex · model$0.45");
    });

    it.each([
        [{ type: "you" }, "Paid by you."],
        [{ type: "member", name: "Petra" }, "Paid by Petra."],
        [{ type: "member", name: null }, "Paid by another member."],
    ] satisfies [
        AiCostPayer,
        string,
    ][])("names a single %j payer once", async (payer, sentence) => {
        mockSummary({
            ...pricedSummary,
            payers: [{ ...pricedSummary.payers[0], payer }],
        });
        renderSummary();
        const panel = await openBreakdown(
            await screen.findByRole("button", {
                name: "Estimated AI spend: $0.45",
            }),
        );
        expect(within(panel).getAllByText(sentence)).toHaveLength(1);
        expect(within(panel).queryByText(/^· /)).toBeNull();
    });

    it.each([
        ["audio", "private"],
        ["audio", "org"],
        ["mail", "private"],
        ["mail", "org"],
    ] as const)("labels every mixed-payer line for %s in %s view", async (_kind, view) => {
        const payers: AiCostPayer[] = [
            { type: "you" },
            { type: "organization" },
            { type: "member", name: "Petra" },
            { type: "member", name: null },
        ];
        mockSummary({
            ...pricedSummary,
            totalUsd: 0.4,
            byOperation: { summary: 0.4 },
            byService: { "Codex · model": 0.4 },
            unknownByService: { "Local AI · model": 4 },
            unknownCount: 4,
            requestCount: 8,
            payers: payers.map((payer) => ({
                payer,
                byOperation: { summary: 0.1 },
                byService: { "Codex · model": 0.1 },
                unknownByService: { "Local AI · model": 1 },
            })),
        });
        renderSummary({ view });
        const panel = await openBreakdown(
            await screen.findByRole("button", {
                name: "Estimated AI spend: at least $0.40",
            }),
        );
        expect(within(panel).queryByText(/^Paid by/)).toBeNull();
        for (const label of [
            "you",
            "Organization",
            "Petra",
            "another member",
        ]) {
            const suffixes = within(panel).getAllByText(`· ${label}`);
            expect(suffixes).toHaveLength(3);
            expect(
                suffixes.map(
                    (suffix) =>
                        suffix.parentElement?.parentElement?.textContent,
                ),
            ).toEqual([
                `Summary· ${label}$0.10`,
                `Codex · model· ${label}$0.10`,
                `Local AI · model· ${label}1 unpriced`,
            ]);
        }
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

    it("shows an at-least total for partially unpriced requests and preserves the notes", async () => {
        mockSummary({
            ...pricedSummary,
            unknownByService: { "Claude Code · model": 1 },
            unknownCount: 1,
            requestCount: 3,
        });
        renderSummary();
        const trigger = await screen.findByRole("button", {
            name: "Estimated AI spend: at least $0.45",
        });
        expect(trigger.textContent).toBe("≥ $0.45");
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

    it("says unpriced with a chevron and lists the services when no request has a price", async () => {
        mockSummary({
            ...emptySummary,
            unknownByService: { "Local AI": 2 },
            unknownCount: 2,
            requestCount: 2,
            payers: [
                {
                    payer: { type: "organization" },
                    byOperation: {},
                    byService: {},
                    unknownByService: { "Local AI": 2 },
                },
            ],
        });
        renderSummary();
        const trigger = await screen.findByRole("button", {
            name: "Estimated AI spend: no price available",
        });
        expect(trigger.textContent).toBe("unpriced");
        expect(trigger.querySelector("svg.lucide-chevron-down")).toBeTruthy();
        const panel = await openBreakdown(trigger);
        expect(
            within(panel).getByText("Estimated AI spend: no price available"),
        ).toBeTruthy();
        expect(
            within(panel).getByText(
                "No request has usable cost data, so there is no total.",
            ),
        ).toBeTruthy();
        expect(
            within(panel).queryByText(
                "Some requests lack usable cost data; the total is incomplete.",
            ),
        ).toBeNull();
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
