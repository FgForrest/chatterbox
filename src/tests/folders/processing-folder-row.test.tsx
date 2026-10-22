// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemWorkflow } from "@/components/pipeline/item-workflow";
import type { CategorizationPanelPresentation } from "@/lib/pipeline/categorization-presentation";
import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import { processingFixture } from "@/tests/pipeline/processing-fixture";
import type { RecordingFolder } from "@/types/folder";

vi.mock("next-intl", () => ({
    useLocale: () => "en",
    useExtracted:
        () =>
        (
            input: string | { message: string },
            values?: Record<string, unknown>,
        ) => {
            const text = typeof input === "string" ? input : input.message;
            return text.replace(/\{(\w+)\}/g, (_match, key: string) =>
                String(values?.[key] ?? ""),
            );
        },
}));

const folder: RecordingFolder = {
    id: "notes",
    parentId: "private-root",
    name: "Notes",
    kind: "custom",
    sortOrder: 0,
    scope: "personal",
    version: 0,
};

const processing: ItemProcessingPresentation = processingFixture({
    itemId: "item-1",
    kind: "audio",
    legacy: false,
    manualOnly: true,
    phases: {
        categorize: {
            state: "done",
            reason: "categorized",
            generation: 1,
            at: "2026-10-16T08:00:00.000Z",
        },
        share: {
            state: "waiting",
            reason: "confirmation_required",
            generation: 1,
            at: "2026-10-16T08:00:00.000Z",
        },
    },
    profile: {
        id: "profile-1",
        name: "Meetings",
        scope: "personal",
        revisionId: "revision-1",
        automatic: { transcribe: false, learn: false, summary: false },
    },
    placements: [
        {
            id: "notes",
            parentId: "private-root",
            name: "Notes",
            path: "Private › Notes",
            scope: "personal",
        },
    ],
    intents: [
        {
            folderId: "sales",
            name: "Sales",
            path: "Organization › Sales",
            confirmationRequired: true,
            confirmed: false,
        },
    ],
    outputs: { transcript: false, learn: false, summary: false },
    processAgain: false,
    processAgainReason: null,
    learnFindingsWaiting: 0,
    taskReviewWaiting: 0,
    jobs: { transcription: null, summary: null },
    failures: [],
});

const panel: CategorizationPanelPresentation = {
    itemId: "item-1",
    folders: [
        {
            id: "notes",
            parentId: "private-root",
            name: "Notes",
            path: "Private › Notes",
            scope: "personal",
        },
    ],
    selectedFolderIds: ["notes"],
    profiles: [
        { id: "profile-1", name: "Meetings", scope: "personal" },
        { id: "profile-2", name: "Calls", scope: "personal" },
    ],
    resolution: {
        status: "resolved",
        profile: { id: "profile-1", name: "Meetings", scope: "personal" },
        manualOnly: true,
        source: "current",
    },
    currentProfile: {
        id: "profile-1",
        name: "Meetings",
        scope: "personal",
    },
    currentManualOnly: true,
    canCreateOrganizationFolders: false,
};

const needsProfile: ItemProcessingPresentation = processingFixture({
    ...processing,
    manualOnly: false,
    phases: {
        categorize: {
            state: "waiting",
            reason: "needs_profile",
            generation: 1,
            at: "2026-10-16T08:00:00.000Z",
        },
    },
    intents: [],
});

function renderWorkflow(
    props: Partial<React.ComponentProps<typeof ItemWorkflow>> = {},
) {
    return render(
        <ItemWorkflow
            itemId="item-1"
            kind="audio"
            initialData={processing}
            folders={[folder]}
            folderAssignments={[{ recordingId: "item-1", folderId: "notes" }]}
            onSelectFolder={vi.fn()}
            onAddToFolder={vi.fn()}
            onRemoveFromFolder={vi.fn()}
            {...props}
        />,
    );
}

describe("processing folder row", () => {
    beforeEach(() => {
        HTMLElement.prototype.scrollIntoView = vi.fn();
        vi.stubGlobal(
            "requestAnimationFrame",
            (callback: FrameRequestCallback) => {
                callback(0);
                return 1;
            },
        );
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
    });

    it("keeps the profile chip on the folder row without Change folders", () => {
        renderWorkflow();
        const row = screen.getByTestId("processing-folder-row");
        expect(row.contains(screen.getByTestId("profile-chip"))).toBe(true);
        expect(row.textContent).toContain("Meetings");
        expect(row.textContent).toContain("Nothing automatic");
        expect(screen.queryByText("Change folders")).toBeNull();
    });

    it("opens the profile menu offered by the categorize endpoint", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json(panel)),
        );
        renderWorkflow();
        fireEvent.mouseEnter(screen.getByTestId("profile-chip"));
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        fireEvent.pointerDown(screen.getByTestId("profile-chip"), {
            button: 0,
            ctrlKey: false,
        });
        expect(await screen.findByText("Calls")).toBeTruthy();
        expect(screen.getByText("Profile")).toBeTruthy();
        expect(screen.getAllByText("Nothing automatic").length).toBeGreaterThan(
            0,
        );
    });

    it("explains the legacy profile chip and adopts a profile through categorization", async () => {
        const onTranscribe = vi.fn();
        const fetchMock = vi.fn(
            async (_input: string | URL | Request, init?: RequestInit) => {
                if (init?.method === "POST") {
                    return new Promise<Response>(() => {});
                }
                return Response.json(panel);
            },
        );
        vi.stubGlobal("fetch", fetchMock);
        renderWorkflow({
            initialData: processingFixture({
                ...processing,
                legacy: true,
                manualOnly: false,
                profile: null,
                outputs: { transcript: true, learn: true, summary: true },
            }),
            onTranscribe,
        });

        const chip = screen.getByTestId("profile-chip");
        expect(chip.textContent).toContain("Processed before profiles");
        fireEvent.focus(chip);
        expect(
            await screen.findAllByText(
                "Choose a profile for this item. Its existing results stay unchanged.",
            ),
        ).not.toHaveLength(0);
        fireEvent.pointerDown(chip, { button: 0, ctrlKey: false });
        fireEvent.click(
            await screen.findByRole("menuitemradio", { name: "Calls" }),
        );

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/recordings/item-1/categorize",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        folderIds: ["notes", "sales"],
                        profileId: "profile-2",
                    }),
                },
            ),
        );
        expect(
            fetchMock.mock.calls.some(([input]) =>
                String(input).includes("process-again"),
            ),
        ).toBe(false);
        expect(onTranscribe).not.toHaveBeenCalled();
    });

    it("loads the owner's processing in the Organization view without actions", async () => {
        const onProcessingChange = vi.fn();
        const memberProcessing = structuredClone(processing);
        for (const step of Object.values(memberProcessing.steps))
            step.actions = [];
        const fetchMock = vi.fn(async () =>
            Response.json({ processing: memberProcessing }),
        );
        vi.stubGlobal("fetch", fetchMock);

        renderWorkflow({
            initialData: undefined,
            isOwn: false,
            view: "org",
            onProcessingChange,
        });

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/recordings/item-1?processing=1&view=org",
            ),
        );
        await waitFor(() =>
            expect(onProcessingChange).toHaveBeenCalledWith(memberProcessing),
        );
        expect(screen.getByLabelText("Workflow")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Share now" })).toBeNull();
    });

    it("starts manual transcription from the workflow action", () => {
        const onTranscribe = vi.fn();
        if (!processing.profile) {
            throw new Error(
                "Expected the processing fixture to have a profile",
            );
        }
        renderWorkflow({
            initialData: processingFixture({
                ...processing,
                manualOnly: false,
                intents: [],
                profile: {
                    ...processing.profile,
                    automatic: {
                        transcribe: false,
                        learn: true,
                        summary: true,
                    },
                },
                phases: {
                    categorize: processing.phases.categorize,
                    transcribe: {
                        state: "waiting",
                        reason: "needs_transcript",
                        generation: 1,
                        at: "2026-10-16T08:00:00.000Z",
                    },
                },
            }),
            onTranscribe,
        });

        fireEvent.click(screen.getByRole("button", { name: "Transcribe" }));
        expect(onTranscribe).toHaveBeenCalledOnce();
    });

    it("forces a transcription retry after a failed run", () => {
        const onTranscribe = vi.fn();
        renderWorkflow({
            initialData: processingFixture({
                ...processing,
                outputs: {
                    ...processing.outputs,
                    transcript: true,
                },
                phases: {
                    ...processing.phases,
                    transcribe: {
                        state: "failed",
                        reason: "TRANSCRIPTION_FAILED",
                        generation: 1,
                        at: "2026-10-16T08:00:00.000Z",
                    },
                },
                failures: [
                    {
                        phase: "transcribe",
                        reasonCode: "TRANSCRIPTION_FAILED",
                        retryAvailable: true,
                    },
                ],
            }),
            onTranscribe,
        });

        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(onTranscribe).toHaveBeenCalledWith(true);
    });

    it("focuses the profile control after a cold filing panel load", async () => {
        let resolvePanel: ((response: Response) => void) | undefined;
        const fetchMock = vi.fn(
            () =>
                new Promise<Response>((resolve) => {
                    resolvePanel = resolve;
                }),
        );
        vi.stubGlobal("fetch", fetchMock);
        renderWorkflow({ initialData: needsProfile });

        fireEvent.click(screen.getByRole("button", { name: "Choose profile" }));
        expect(screen.queryByRole("combobox", { name: "Profile" })).toBeNull();
        resolvePanel?.(Response.json(panel));

        const profile = await screen.findByRole("combobox", {
            name: "Profile",
        });
        await waitFor(() => expect(document.activeElement).toBe(profile));
    });

    it("focuses the profile control at once when the panel is warm", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json(panel)),
        );
        renderWorkflow({ initialData: needsProfile });
        const profile = await screen.findByRole("combobox", {
            name: "Profile",
        });
        profile.blur();

        fireEvent.click(screen.getByRole("button", { name: "Choose profile" }));

        expect(document.activeElement).toBe(profile);
    });

    it("shows the workflow strip and Categorize card when uploaded processing arrives late", async () => {
        vi.useFakeTimers();
        try {
            const waiting: ItemProcessingPresentation = processingFixture({
                ...needsProfile,
                phases: {
                    categorize: {
                        state: "waiting",
                        reason: "needs_folder",
                        generation: 0,
                        at: "2026-10-16T08:00:03.000Z",
                    },
                },
            });
            const filingPanel: CategorizationPanelPresentation = {
                ...panel,
                selectedFolderIds: [],
                currentProfile: null,
                currentManualOnly: false,
                resolution: { status: "choose", candidates: [] },
            };
            let processingReads = 0;
            vi.stubGlobal(
                "fetch",
                vi.fn(async (input: string | URL | Request) => {
                    const url = String(input);
                    if (url.endsWith("/categorize")) {
                        return Response.json(filingPanel);
                    }
                    processingReads += 1;
                    return Response.json({
                        processing: processingReads < 3 ? null : waiting,
                    });
                }),
            );
            invalidateItemProcessing("item-1");
            renderWorkflow({ initialData: null });

            await act(async () => {});
            await act(async () => {
                await vi.advanceTimersByTimeAsync(5_000);
            });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(5_000);
            });

            expect(
                screen.getByText(
                    "Choose a folder and a profile. Nothing is processed until the recording is filed.",
                ),
            ).toBeTruthy();
            expect(
                screen.getByRole("heading", { name: "Categorize recording" }),
            ).toBeTruthy();
        } finally {
            vi.useRealTimers();
        }
    });

    it("confirms intended Organization placements from Share now", async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.endsWith("/confirm"))
                return Response.json({ confirmed: 1 });
            if (url.includes("?processing=1")) {
                return Response.json({ processing });
            }
            return Response.json(panel);
        });
        vi.stubGlobal("fetch", fetchMock);
        renderWorkflow();
        fireEvent.click(
            screen.getAllByRole("button", { name: "Share now" })[0],
        );
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/recordings/item-1/intended-placements/confirm",
                { method: "POST" },
            ),
        );
    });
});
