// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemWorkflow } from "@/components/pipeline/item-workflow";
import type { CategorizationPanelPresentation } from "@/lib/pipeline/categorization-presentation";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import type { RecordingFolder } from "@/types/folder";

vi.mock("next-intl", () => ({
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

const processing: ItemProcessingPresentation = {
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
};

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

    it("starts manual transcription from the workflow action", () => {
        const onTranscribe = vi.fn();
        if (!processing.profile) {
            throw new Error(
                "Expected the processing fixture to have a profile",
            );
        }
        renderWorkflow({
            initialData: {
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
            },
            onTranscribe,
        });

        fireEvent.click(screen.getByRole("button", { name: "Transcribe" }));
        expect(onTranscribe).toHaveBeenCalledOnce();
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
