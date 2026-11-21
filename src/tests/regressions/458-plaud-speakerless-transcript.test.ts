import { describe, expect, it, vi } from "vitest";
import { planAdvance } from "@/lib/pipeline/plan";
import type { PipelineFacts } from "@/lib/pipeline/types";
import { plaudV4DetailToLegacy } from "@/lib/plaud/v4";

const startedAt = "2026-11-20T12:00:00.000Z";
const at = "2026-11-20T12:10:00.000Z";
const input = {
    contentId: "plaud-transcript",
    contentSourceId: "plaud",
    contentRevision: 2,
};
const settled = {
    state: "done",
    reason: "plaud-transcript",
    generation: 1,
    inputs: input,
    at: startedAt,
} as const;

function facts(hasSpeakerLabels = false, automatic = true) {
    const plaud = {
        ...input,
        timed: true,
        lacksConfirmableSpeakers: () => !hasSpeakerLabels,
    };
    return {
        item: {
            exists: true,
            deleted: false,
            kind: "audio",
            ownerUserId: "owner",
        },
        view: "private",
        generation: 2,
        content: null,
        transcription: { riffado: null, plaud, jobActive: false },
        summaryDueAt: null,
        profile: {
            revisionId: "profile-revision",
            transcribe: { automatic, plaudTranscript: "use" },
            automatic: {
                learn: false,
                summary: false,
                title: false,
                topics: false,
            },
        },
        categorization: {
            placementFolderIds: ["private-folder"],
            intendedFolderIds: [],
            profileAssigned: true,
            resolution: "resolved",
        },
        hasEnhancementCredential: false,
        mail: null,
        summary: { exists: false, stale: false, jobActive: false },
        taskReview: { proposals: 0, followUps: 0 },
        phases: {
            categorize: {
                state: "done",
                reason: "categorized",
                arrivalGeneration: 1,
                generation: 1,
                at: startedAt,
            },
        },
        at,
    } satisfies PipelineFacts;
}

const queued = { type: "queueTranscription" };
const running = {
    type: "markPhase",
    phase: "transcribe",
    record: expect.objectContaining({
        state: "running",
        reason: "automatic",
        automatic: true,
    }),
};
const usesPlaud = {
    type: "markPhase",
    phase: "transcribe",
    record: expect.objectContaining({
        state: "done",
        reason: "plaud-transcript",
        inputs: input,
    }),
};

describe("#458 Plaud speaker-less transcript selection", () => {
    it("queues automatic transcription for unlabelled Plaud turns", () => {
        expect(planAdvance(facts()).actions).toEqual(
            expect.arrayContaining([queued, running]),
        );
    });

    it("uses a labelled Plaud transcript", () => {
        expect(planAdvance(facts(true)).actions).toContainEqual(usesPlaud);
    });

    it("keeps the exact settled Plaud input on a filing advance", () => {
        const current = facts();
        expect(
            planAdvance({
                ...current,
                phases: { ...current.phases, transcribe: settled },
            }).actions,
        ).not.toContainEqual(queued);
    });

    it.each([
        { contentId: "older-row" },
        { contentRevision: 1 },
        { contentSourceId: "riffado" },
    ])("keeps Plaud when the settled input differs (%j)", (change) => {
        const current = facts();
        expect(
            planAdvance({
                ...current,
                phases: {
                    ...current.phases,
                    transcribe: { ...settled, inputs: { ...input, ...change } },
                },
            }).actions,
        ).toContainEqual(usesPlaud);
    });

    it("re-decides a settled Plaud input on Process again", () => {
        const current = facts();
        expect(
            planAdvance({
                ...current,
                phases: {
                    categorize: {
                        state: "done",
                        reason: "process_again",
                        arrivalGeneration: 1,
                        generation: 2,
                        at,
                    },
                    transcribe: settled,
                },
            }).actions,
        ).toContainEqual(queued);
    });

    it("uses unlabelled Plaud turns for a manual-only item", () => {
        expect(
            planAdvance({ ...facts(), manualOnly: true }).actions,
        ).toContainEqual(usesPlaud);
    });

    it("uses unlabelled Plaud turns when automatic transcription is off", () => {
        expect(planAdvance(facts(false, false)).actions).toContainEqual(
            usesPlaud,
        );
    });

    it("marks a read-only share waiting for a transcript when automatic transcription is off", () => {
        const current = facts(false, false);
        const actions = planAdvance({
            ...current,
            transcription: {
                ...current.transcription,
                plaud: null,
                sharedReadOnly: true,
            },
        }).actions;
        expect(actions).toContainEqual({
            type: "markPhase",
            phase: "transcribe",
            record: expect.objectContaining({
                state: "waiting",
                reason: "needs_transcript",
            }),
        });
    });

    it("marks a completed automatic failure on a read-only share", () => {
        const current = facts();
        const actions = planAdvance({
            ...current,
            transcription: {
                ...current.transcription,
                plaud: null,
                sharedReadOnly: true,
                failed: {
                    completedAt: at,
                    errorCode: "NO_TRANSCRIPTION_PROVIDER",
                },
            },
            phases: {
                ...current.phases,
                transcribe: {
                    state: "running",
                    reason: "automatic",
                    automatic: true,
                    generation: current.generation,
                    at: startedAt,
                },
            },
        }).actions;
        expect(actions).toContainEqual({
            type: "markPhase",
            phase: "transcribe",
            record: expect.objectContaining({
                state: "failed",
                reason: "NO_TRANSCRIPTION_PROVIDER",
                automatic: true,
            }),
        });
        expect(actions).not.toContainEqual(queued);
    });

    it("leaves automatic transcription unqueued on a read-only share without an active job", () => {
        const current = facts();
        const actions = planAdvance({
            ...current,
            transcription: {
                ...current.transcription,
                plaud: null,
                sharedReadOnly: true,
            },
        }).actions;
        expect(actions).not.toContainEqual(queued);
        expect(actions).not.toContainEqual(running);
    });

    it("settles on Plaud after our automatic attempt fails and keeps it on the next advance", () => {
        const current: PipelineFacts = facts();
        current.phases.transcribe = {
            state: "failed",
            reason: "NO_TRANSCRIPTION_PROVIDER",
            automatic: true,
            generation: 1,
            at: startedAt,
        };
        const actions = planAdvance(current).actions;
        expect(actions).toContainEqual(usesPlaud);
        const mark = actions.find(
            (action) =>
                action.type === "markPhase" && action.phase === "transcribe",
        );
        if (mark?.type !== "markPhase")
            throw new Error("Expected a Transcribe mark");
        current.phases.transcribe = mark.record;
        expect(
            planAdvance({ ...current, generation: 3 }).actions,
        ).not.toContainEqual(queued);
    });

    it("disregards an automatic failure from before the current attempt", () => {
        const current: PipelineFacts = facts();
        current.phases.transcribe = {
            state: "running",
            reason: "automatic",
            automatic: true,
            generation: 2,
            at,
        };
        const actions = planAdvance({
            ...current,
            transcription: {
                ...facts().transcription,
                jobActive: true,
                failed: {
                    errorCode: "NO_TRANSCRIPTION_PROVIDER",
                    completedAt: startedAt,
                },
            },
        }).actions;
        expect(actions).not.toContainEqual(usesPlaud);
        expect(actions).not.toContainEqual(queued);
    });

    it("checks speakers only when the fresh Plaud row can be replaced", () => {
        const fresh = facts();
        const inspectSpeakers = vi.fn(() => true);
        fresh.transcription.plaud.lacksConfirmableSpeakers = inspectSpeakers;
        const own = {
            ...input,
            contentId: "own",
            contentSourceId: "riffado",
            timed: true,
        };
        for (const current of [
            {
                ...fresh,
                transcription: { ...fresh.transcription, riffado: own },
            },
            { ...fresh, manualOnly: true },
            {
                ...fresh,
                profile: {
                    ...fresh.profile,
                    transcribe: {
                        ...fresh.profile.transcribe,
                        automatic: false,
                    },
                },
            },
            { ...fresh, phases: { ...fresh.phases, transcribe: settled } },
            {
                ...fresh,
                phases: {
                    ...fresh.phases,
                    categorize: {
                        ...fresh.phases.categorize,
                        arrivalGeneration: undefined,
                    },
                },
            },
            {
                ...fresh,
                phases: {
                    ...fresh.phases,
                    learn: { ...settled, reason: "finished" },
                },
            },
        ]) {
            planAdvance(current);
        }
        expect(inspectSpeakers).not.toHaveBeenCalled();
        expect(planAdvance(fresh).actions).toContainEqual(queued);
        expect(inspectSpeakers).toHaveBeenCalledOnce();
    });

    it("prefers our transcript when it arrives", () => {
        const current: PipelineFacts = facts(true);
        const own = { ...input, contentId: "own", contentSourceId: "riffado" };
        const actions = planAdvance({
            ...current,
            transcription: {
                ...facts(true).transcription,
                riffado: { ...own, timed: true },
            },
        }).actions;
        expect(actions).toContainEqual({
            type: "markPhase",
            phase: "transcribe",
            record: expect.objectContaining({ state: "done", inputs: own }),
        });
    });

    it("keeps automatic transcription for also_transcribe with a labelled Plaud transcript", () => {
        const current = facts(true);
        expect(
            planAdvance({
                ...current,
                profile: {
                    ...current.profile,
                    transcribe: {
                        automatic: true,
                        plaudTranscript: "also_transcribe",
                    },
                },
            }).actions,
        ).toContainEqual(queued);
    });

    it("carries the v4 transcript object's language into the import manifest", () => {
        const object = {
            object_type: "TRANSCRIPT",
            task_status: 1,
            content_url: "https://example.com/transcript.json",
            language: "cs",
        };
        expect(
            plaudV4DetailToLegacy({ objects: [object] }).data?.content_list,
        ).toMatchObject([{ data_type: "transaction", language: "cs" }]);
    });
});
