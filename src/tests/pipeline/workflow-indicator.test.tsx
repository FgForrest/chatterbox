// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    type ItemProcessingPresentation,
    WorkflowIndicator,
} from "@/components/pipeline/workflow-indicator";

vi.mock("next-intl", () => ({
    useExtracted: () => (text: string, values?: Record<string, unknown>) =>
        text.replace(/\{(\w+)\}/g, (_match, key: string) =>
            String(values?.[key] ?? ""),
        ),
}));

function processing(
    overrides: Partial<ItemProcessingPresentation> = {},
): ItemProcessingPresentation {
    return {
        itemId: "item-1",
        kind: "audio",
        legacy: false,
        manualOnly: false,
        phases: {},
        profile: {
            id: "profile-1",
            name: "Meetings",
            revisionId: "revision-1",
            automatic: { transcribe: true, learn: true, summary: true },
        },
        placements: [],
        intents: [],
        outputs: { transcript: false, summary: false, learn: false },
        ...overrides,
    };
}

describe("workflow indicator", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it.each([
        ["pending", "Pending"],
        ["waiting", "Waiting"],
        ["running", "Running"],
        ["done", "Done"],
        ["skipped", "Skipped"],
        ["failed", "Failed"],
        ["not_processed", "Not processed"],
    ] as const)("renders the %s state with its label", (state, label) => {
        render(
            <WorkflowIndicator
                initialData={processing({
                    phases: {
                        summary: {
                            state,
                            reason:
                                state === "skipped" ? "no_provider" : undefined,
                            generation: 1,
                            at: "2026-10-15T00:00:00.000Z",
                        },
                    },
                })}
            />,
        );
        expect(
            screen.getByText("Summary").closest("li")?.textContent,
        ).toContain(label);
    });

    it("renders waiting actions and the Learn timeout copy", () => {
        render(
            <WorkflowIndicator
                initialData={processing({
                    intents: [
                        {
                            folderId: "sales",
                            name: "Sales",
                            path: "Organization › Sales",
                        },
                    ],
                    phases: {
                        categorize: {
                            state: "waiting",
                            reason: "needs_folder",
                            generation: 1,
                            at: "2026-10-15T00:00:00.000Z",
                        },
                        learn: {
                            state: "waiting",
                            reason: "review_pending_timeout",
                            generation: 1,
                            at: "2026-10-15T00:00:00.000Z",
                        },
                        taskReview: {
                            state: "waiting",
                            reason: "needs_review",
                            generation: 1,
                            at: "2026-10-15T00:00:00.000Z",
                        },
                    },
                })}
            />,
        );
        expect(screen.getAllByRole("button", { name: "File it" })).toHaveLength(
            2,
        );
        expect(
            screen.getByRole("button", { name: "Review Learn" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Review tasks" }),
        ).toBeTruthy();
        expect(
            screen.getByText("Learn review pending; summary made without it"),
        ).toBeTruthy();
    });

    it("offers profile choice only for a profile disagreement", () => {
        render(
            <WorkflowIndicator
                initialData={processing({
                    profile: null,
                    phases: {
                        categorize: {
                            state: "waiting",
                            reason: "needs_profile",
                            generation: 1,
                            at: "2026-10-15T00:00:00.000Z",
                        },
                    },
                })}
            />,
        );
        expect(
            screen.getByRole("button", { name: "Choose a profile" }),
        ).toBeTruthy();
    });

    it("shows manual phases as By hand and completed current outputs as done", () => {
        render(
            <WorkflowIndicator
                initialData={processing({
                    manualOnly: true,
                    profile: {
                        id: "profile-1",
                        name: "Meetings",
                        revisionId: "revision-1",
                        automatic: {
                            transcribe: false,
                            learn: false,
                            summary: false,
                        },
                    },
                    phases: {
                        transcribe: {
                            state: "skipped",
                            reason: "manual_only",
                            generation: 1,
                            at: "2026-10-15T00:00:00.000Z",
                        },
                        learn: {
                            state: "skipped",
                            reason: "manual_only",
                            generation: 1,
                            at: "2026-10-15T00:00:00.000Z",
                        },
                        summary: {
                            state: "skipped",
                            reason: "manual_only",
                            generation: 1,
                            at: "2026-10-15T00:00:00.000Z",
                        },
                    },
                    outputs: { transcript: true, learn: false, summary: false },
                })}
            />,
        );
        expect(screen.getAllByText("By hand")).toHaveLength(2);
        expect(screen.getByRole("button", { name: "Learn" })).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Generate summary" }),
        ).toBeTruthy();
        expect(
            screen.getByText("Transcribe").parentElement?.textContent,
        ).toContain("Done");
    });

    it("shows a profile-disabled step as By hand without a phase record", () => {
        render(
            <WorkflowIndicator
                initialData={processing({
                    profile: {
                        id: "profile-1",
                        name: "Meetings",
                        revisionId: "revision-1",
                        automatic: {
                            transcribe: true,
                            learn: true,
                            summary: false,
                        },
                    },
                })}
            />,
        );
        expect(
            screen.getByText("Summary").parentElement?.textContent,
        ).toContain("By hand");
        expect(
            screen.getByRole("button", { name: "Generate summary" }),
        ).toBeTruthy();
    });

    it("does not show Transcribe for mail", () => {
        render(
            <WorkflowIndicator initialData={processing({ kind: "mail" })} />,
        );
        expect(screen.queryByText("Transcribe")).toBeNull();
    });

    it("shows legacy items without a waiting badge", () => {
        render(
            <WorkflowIndicator
                initialData={processing({ legacy: true, profile: null })}
            />,
        );
        expect(screen.getByText("Processed before profiles")).toBeTruthy();
        expect(screen.queryByText("Waiting for you to file it")).toBeNull();
    });

    it("shows an intended Organization chip and lets the owner cancel it", async () => {
        const fetchMock = vi.fn(async () => Response.json({ cancelled: true }));
        vi.stubGlobal("fetch", fetchMock);
        render(
            <WorkflowIndicator
                initialData={processing({
                    intents: [
                        {
                            folderId: "sales",
                            name: "Sales",
                            path: "Organization › Sales",
                        },
                    ],
                })}
            />,
        );
        expect(
            screen.getByText("Organization › Sales · shares after review"),
        ).toBeTruthy();
        fireEvent.click(
            screen.getByRole("button", { name: "Cancel Organization › Sales" }),
        );
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/recordings/item-1/intended-placements/sales",
                { method: "DELETE" },
            ),
        );
        expect(
            screen.queryByText("Organization › Sales · shares after review"),
        ).toBeNull();
    });
});
