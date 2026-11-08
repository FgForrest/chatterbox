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
import { TranscriptView } from "@/components/dashboard/transcript-view";
import {
    RecordingCutPanel,
    RecordingCutProvider,
} from "@/components/recordings/recording-cut";
import { TrimProposalCard } from "@/components/recordings/trim-proposal-card";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import { projectProcessing } from "@/lib/pipeline/processing-status";
import { deriveWorkflowStatus } from "@/lib/pipeline/workflow-status";
import { deriveWorkflowWidgets } from "@/lib/pipeline/workflow-widgets";
import type { StoredTrimProposal } from "@/lib/recordings/trim-proposal";
import { processingFixture } from "@/tests/pipeline/processing-fixture";
import type { Recording } from "@/types/recording";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
const fetchMock = vi.fn();
const turns = [
    { speaker: "S1", startMs: 0, endMs: 2000, text: "Opening words." },
    { speaker: "S1", startMs: 3000, endMs: 7000, text: "Budget decision." },
    { speaker: "S1", startMs: 8000, endMs: 10000, text: "Closing words." },
];
const recording: Recording = {
    id: "recording",
    filename: "Budget meeting",
    duration: 10000,
    filesize: 10,
    startTime: "2026-11-08T00:00:00Z",
    deviceSn: "local",
};
const proposal: StoredTrimProposal = {
    schemaVersion: 1,
    id: "proposal",
    promptVersion: 1,
    createdAt: "2026-11-08T00:00:00Z",
    deadline: "2026-11-08T04:00:00Z",
    transcript: { id: "transcript", revision: 2, source: "riffado" },
    revisions: [{ id: "transcript", revision: 2 }],
    inputFingerprint: "fingerprint",
    audio: { fileMd5: "a", duration: 10000, cutAt: null },
    profileRevisionId: "recipe",
    provider: {
        credentialId: "chat",
        provider: "Custom",
        model: "local-model",
        payerUserId: "owner",
    },
    start: {
        firstKeptSentenceId: "t1s0",
        startMs: 3000,
        reason: "Unrelated opening",
    },
    end: {
        firstRemovedSentenceId: "t2s0",
        startMs: 8000,
        reason: "Unrelated closing",
    },
};
function processing(): ItemProcessingPresentation {
    return processingFixture({
        itemId: "recording",
        kind: "audio",
        legacy: false,
        manualOnly: false,
        phases: {
            categorize: {
                state: "done",
                generation: 1,
                at: proposal.createdAt,
            },
            transcribe: {
                state: "done",
                generation: 1,
                at: proposal.createdAt,
            },
            trim: {
                state: "waiting",
                reason: "review_pending",
                generation: 1,
                at: proposal.createdAt,
                waitingFor: { kind: "trimReview", until: proposal.deadline },
            },
        },
        trimProposal: proposal,
        profile: null,
        placements: [],
        intents: [],
        outputs: { transcript: true, learn: false, summary: false },
        processAgain: false,
        processAgainReason: null,
        learnFindingsWaiting: 0,
        taskReviewWaiting: 0,
        jobs: { transcription: null, summary: null },
        failures: [],
    });
}
function recordingView(
    overrides: Partial<Recording> = {},
    data = processing(),
) {
    return (
        <RecordingCutProvider
            recording={{ ...recording, ...overrides }}
            transcripts={[
                {
                    turns,
                    version: { transcriptionId: "transcript", revision: 2 },
                },
            ]}
            transcribing={false}
            shared
            onChanged={vi.fn()}
        >
            <TrimProposalCard processing={data} userId="owner" />
            <RecordingCutPanel />
            <TranscriptView
                text={turns.map((t) => t.text).join(" ")}
                source="riffado"
                model="fake"
                storedTurns={turns}
            />
        </RecordingCutProvider>
    );
}
function view(overrides: Partial<Recording> = {}, data = processing()) {
    return render(recordingView(overrides, data));
}
describe("owner trim card", () => {
    beforeEach(() => {
        fetchMock.mockImplementation(async () => new Response('{"job":null}'));
        vi.stubGlobal("fetch", fetchMock);
        Element.prototype.scrollIntoView = vi.fn();
    });
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });
    it("marks proposals with cut mode closed and clears unchecked edges", () => {
        view();
        expect(
            screen.getByRole("region", { name: "Trim off-topic talk?" }),
        ).toBeTruthy();
        expect(document.querySelectorAll("[data-trim-proposed]").length).toBe(
            2,
        );
        fireEvent.click(screen.getByRole("checkbox", { name: "Beginning" }));
        expect(document.querySelectorAll("[data-trim-proposed]").length).toBe(
            1,
        );
        fireEvent.click(screen.getByRole("checkbox", { name: "End" }));
        expect(document.querySelectorAll("[data-trim-proposed]").length).toBe(
            0,
        );
        expect(
            screen
                .getByRole("button", { name: "Cut selected…" })
                .hasAttribute("disabled"),
        ).toBe(true);
    });
    it("prefills the existing destructive confirmation without submitting a cut", () => {
        view();
        fireEvent.click(screen.getByRole("button", { name: "Cut selected…" }));
        expect(screen.getByRole("alertdialog")).toBeTruthy();
        expect(screen.getByText("Delete the cut parts?")).toBeTruthy();
        expect(screen.getByText("This cannot be undone.")).toBeTruthy();
        expect(
            fetchMock.mock.calls.some(([, init]) => init?.method === "POST"),
        ).toBe(false);
        expect(screen.getByDisplayValue("00:03").getAttribute("value")).toBe(
            "00:03",
        );
    });
    it("edits the checked range and leaves the decision card pending", () => {
        view();
        fireEvent.click(screen.getByRole("checkbox", { name: "End" }));
        fireEvent.click(
            screen.getByRole("button", { name: "Adjust in transcript" }),
        );
        expect(screen.queryByRole("alertdialog")).toBeNull();
        expect(
            screen.getByRole("textbox", { name: "To" }).getAttribute("value"),
        ).toBe("00:10");
        expect(screen.getByText("Trim off-topic talk?")).toBeTruthy();
    });
    it("keeps edits on refresh and discards stale confirmation when the proposal changes", () => {
        const data = processing();
        const result = view({}, data);
        fireEvent.click(
            screen.getByRole("button", { name: "Adjust in transcript" }),
        );
        const from = screen.getByRole("textbox", { name: "From" });
        fireEvent.change(from, { target: { value: "00:00" } });
        fireEvent.blur(from);
        result.rerender(recordingView({}, { ...data }));
        expect(
            screen.getByRole("textbox", { name: "From" }).getAttribute("value"),
        ).toBe("00:00");
        fireEvent.click(screen.getByRole("button", { name: "Cut selected…" }));
        expect(screen.getByDisplayValue("00:03")).toBeTruthy();
        expect(screen.getByRole("alertdialog")).toBeTruthy();
        result.rerender(
            recordingView(
                {},
                { ...data, trimProposal: { ...proposal, id: "replacement" } },
            ),
        );
        expect(screen.queryByRole("alertdialog")).toBeNull();
        expect(screen.queryByRole("textbox", { name: "From" })).toBeNull();
        expect(document.querySelectorAll("[data-trim-proposed]").length).toBe(
            2,
        );
    });
    it("optimistically declines and restores the card after a conflict", async () => {
        view();
        let finish: (response: Response) => void = () => {};
        fetchMock.mockImplementation((url: string) =>
            url.endsWith("trim-proposal")
                ? new Promise<Response>((done) => {
                      finish = done;
                  })
                : Promise.resolve(new Response('{"job":null}')),
        );
        fireEvent.click(screen.getByRole("button", { name: "Do not trim" }));
        expect(screen.queryByText("Trim off-topic talk?")).toBeNull();
        expect(document.querySelectorAll("[data-trim-proposed]").length).toBe(
            0,
        );
        await act(async () => finish(new Response("{}", { status: 409 })));
        await waitFor(() =>
            expect(screen.getByText("Trim off-topic talk?")).toBeTruthy(),
        );
    });
    it.each([
        { isOwn: false },
        { view: "org" as const },
        { view: "received" as const },
    ])("hides private controls for a reader %j", (override) => {
        view(override);
        expect(screen.queryByText("Trim off-topic talk?")).toBeNull();
        expect(document.querySelectorAll("[data-trim-proposed]").length).toBe(
            0,
        );
    });
    it("projects trim into Learn without another visible step or a competing Learn widget", () => {
        const data = processing();
        const workflow = deriveWorkflowStatus(data, "audio");
        expect(workflow.steps.map((s) => s.id)).not.toContain("trim");
        expect(workflow.steps.find((s) => s.id === "learn")?.state).toBe(
            "review",
        );
        expect(workflow.status).toMatchObject({
            actor: "yours",
            message: "trimReview",
            action: "reviewTrim",
        });
        expect(deriveWorkflowWidgets(data).learn.visible).toBe(false);
    });
    it("shows actual cutting in the Learn position while the decision remains pending", () => {
        const data = processing();
        const projected = projectProcessing(
            data,
            [
                {
                    id: "cut-job",
                    kind: "recording.cut",
                    status: "processing",
                    retryAt: null,
                    result: null,
                    errorCode: null,
                    bindings: [],
                    unbound: true,
                    stale: false,
                    position: 1,
                },
            ],
            { canChange: true, canFile: true },
            new Date(proposal.createdAt),
        );
        const workflow = deriveWorkflowStatus(projected, "audio");
        expect(workflow.status?.message).toBe("trimCutting");
        expect(projected.steps.learn.waitingFor?.kind).toBe("cut");
    });
    it("exposes an explicit manual summary action while trim waits", async () => {
        view();
        fireEvent.click(screen.getByText("Process without trimming"));
        fireEvent.click(
            screen.getByRole("button", { name: "Summarize without trimming" }),
        );
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining("/summary?source=riffado&view=private"),
                expect.objectContaining({ method: "POST" }),
            ),
        );
    });
    it("tells a shared reader that the trim decision belongs to someone else", () => {
        const data = projectProcessing(
            processing(),
            [],
            { canChange: false, canFile: false },
            new Date(proposal.createdAt),
        );
        const workflow = deriveWorkflowStatus(data, "audio");
        expect(workflow.status).toMatchObject({
            actor: "others",
            message: "trimReview",
        });
        expect(workflow.status?.action).toBeUndefined();
    });
    it("polls against the stored deadline", () => {
        const data = processing();
        const now = new Date(Date.parse(proposal.deadline) - 5000);
        const projected = projectProcessing(
            data,
            [],
            { canChange: true, canFile: true },
            now,
        );
        expect(projected.nextCheckInMs).toBe(5000);
        expect(projected.phases.learn).toBeUndefined();
    });
});
