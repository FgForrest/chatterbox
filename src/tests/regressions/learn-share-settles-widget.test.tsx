// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearnWidget } from "@/components/learn/learn-widget";

vi.mock("next-intl", () => ({
    useLocale: () => "en",
    useExtracted:
        () =>
        (
            message: string | { message: string },
            values?: Record<string, string | number>,
        ) =>
            (typeof message === "string" ? message : message.message).replace(
                /\{(\w+)\}/g,
                (match, key: string) => String(values?.[key] ?? match),
            ),
}));
vi.mock("sonner", () => ({
    toast: {
        error: vi.fn(),
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
    },
}));

afterEach(async () => {
    cleanup();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
});

it("shows completion without inventing counts for an older review", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
            Response.json({
                run: {
                    id: "older-receipt",
                    status: "finished",
                    sharedReview: {
                        applied: null,
                        skipped: null,
                        dismissed: null,
                    },
                },
                items: [],
                names: {},
                types: {},
                relations: {},
                available: true,
            }),
        ),
    );
    render(
        <LearnWidget
            recordingId="shared-item"
            view="org"
            showTrigger={false}
        />,
    );
    await screen.findByText("Learned from the owner's review");
    expect(screen.queryByText(/applied, .* skipped/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View results" }));
    await screen.findByRole("dialog");
    expect(screen.queryByText(/Learn found nothing new/)).toBeNull();
});

describe.each([
    "audio",
    "mail",
] as const)("%s Organization Learn receipt", (kind) => {
    it.each([
        "inline",
        "dialog",
    ] as const)("shows the owner's finished review in the %s frame and allows relearning", async (frame) => {
        const fetchMock = vi.fn(
            async (_input: RequestInfo | URL, init?: RequestInit) =>
                Response.json(
                    init?.method === "POST"
                        ? { jobId: null }
                        : {
                              run: {
                                  id: "org-receipt",
                                  status: "finished",
                                  sharedReview: {
                                      applied: 7,
                                      skipped: 2,
                                      dismissed: 3,
                                  },
                              },
                              items: [],
                              names: {},
                              types: {},
                              relations: {},
                              available: true,
                          },
                ),
        );
        vi.stubGlobal("fetch", fetchMock);
        render(
            <LearnWidget
                kind={kind}
                recordingId="shared-item"
                view="org"
                frame={frame}
                showTrigger={false}
            />,
        );

        await screen.findByText("Learned from the owner's review");
        expect(screen.getByText("7 applied, 2 skipped")).toBeTruthy();
        expect(screen.queryByText(/Ready when you are/)).toBeNull();
        expect(screen.queryByRole("button", { name: "Learn" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "View results" }));
        await screen.findByRole("dialog");
        expect(screen.queryByText(/Learn found nothing new/)).toBeNull();
        expect(screen.getAllByText("7 applied, 2 skipped")).toHaveLength(2);
        fireEvent.click(screen.getByRole("button", { name: "Re-learn" }));
        const path =
            kind === "audio"
                ? "/api/recordings/shared-item/learn?source=riffado&view=org"
                : "/api/recordings/shared-item/learn?view=org";
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(path, { method: "POST" }),
        );
    });
});

it.each([
    "audio",
    "mail",
] as const)("shows that automatic Learn found nothing in a shared %s", async (kind) => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
            Response.json({
                run: {
                    id: "empty-receipt",
                    status: "finished",
                    sharedReview: { applied: 0, skipped: 0, dismissed: 0 },
                },
                items: [],
                names: {},
                types: {},
                relations: {},
                available: true,
            }),
        ),
    );
    render(
        <LearnWidget
            kind={kind}
            recordingId="shared-item"
            view="org"
            showTrigger={false}
        />,
    );
    await screen.findByText("Learn found nothing new");
    expect(screen.queryByText("Learned from the owner's review")).toBeNull();
    expect(screen.queryByText("0 applied, 0 skipped")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View results" }));
    await screen.findByText(
        kind === "mail"
            ? "Learn found nothing new in this message."
            : "Learn found nothing new in this transcript.",
    );
    expect(screen.queryByText("Learned from the owner's review")).toBeNull();
    expect(screen.queryByText("0 applied, 0 skipped")).toBeNull();
    expect(screen.getByRole("button", { name: "Re-learn" })).toBeTruthy();
});
