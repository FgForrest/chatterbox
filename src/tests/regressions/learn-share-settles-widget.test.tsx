// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearnWidget } from "@/components/learn/learn-widget";
import { relearnItem } from "@/components/learn/review-events";

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
    await act(async () => {});
    expect(screen.queryByText("Learned from the owner's review")).toBeNull();
    expect(screen.queryByText(/applied, .* skipped/)).toBeNull();
    expect(screen.queryByRole("button", { name: "View results" })).toBeNull();
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

        await act(async () => {});
        expect(
            screen.queryByText("Learned from the owner's review"),
        ).toBeNull();
        expect(screen.queryByText(/Ready when you are/)).toBeNull();
        expect(screen.queryByRole("button", { name: "Learn" })).toBeNull();
        act(() => relearnItem("shared-item", false));
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
    await act(async () => {});
    expect(screen.queryByText("Learn found nothing new")).toBeNull();
    expect(screen.queryByText("Learned from the owner's review")).toBeNull();
    expect(screen.queryByText("0 applied, 0 skipped")).toBeNull();
    expect(screen.queryByRole("button", { name: "View results" })).toBeNull();
});
