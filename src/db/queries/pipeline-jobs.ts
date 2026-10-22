import { and, eq, isNull, sql } from "drizzle-orm";
import type { db } from "@/db";
import {
    aiEnhancements,
    asyncJobs,
    chatterItems,
    itemProcessing,
    learnRuns,
    mailContents,
    transcriptCorrectionPasses,
    transcriptions,
} from "@/db/schema";
import { pipelineDriver } from "@/lib/pipeline/driver";
import { outcomeRecord, type StepOutcome } from "@/lib/pipeline/outcome";
import { automaticTitleSettled } from "@/lib/pipeline/title-step";
import type {
    ContentRevisionInput,
    PhaseName,
    PhaseRecord,
    PhaseState,
    PhaseStepRecord,
    PipelinePhases,
    SummaryStepName,
} from "@/lib/pipeline/types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Job = typeof asyncJobs.$inferSelect;

export interface PipelineJobTarget {
    itemId: string;
    userId: string;
    phase: PhaseName;
    step?: SummaryStepName;
    record?: PhaseRecord;
    existingOnly?: boolean;
}

export interface PipelineJobBinding extends PipelineJobTarget {
    generation: number;
}

/** Whether two bindings name the same item step at the same generation. */
export function sameBinding(
    a: PipelineJobBinding,
    b: PipelineJobBinding,
): boolean {
    return (
        a.itemId === b.itemId &&
        a.userId === b.userId &&
        a.phase === b.phase &&
        a.step === b.step &&
        a.generation === b.generation
    );
}

/** Read only validated, owner-scoped binding metadata from the job payload. */
export function jobBindings(
    payload: Record<string, unknown>,
): PipelineJobBinding[] {
    if (!Array.isArray(payload.pipelineSteps)) return [];
    return payload.pipelineSteps.filter(
        (entry): entry is PipelineJobBinding =>
            entry !== null &&
            typeof entry === "object" &&
            typeof entry.itemId === "string" &&
            typeof entry.userId === "string" &&
            [
                "categorize",
                "transcribe",
                "learn",
                "summary",
                "taskReview",
                "share",
            ].includes(entry.phase) &&
            (entry.step === undefined ||
                ["summary", "topics", "title"].includes(entry.step)) &&
            Number.isSafeInteger(entry.generation),
    );
}

function jobPhase(kind: string): PhaseName | undefined {
    if (kind === "transcription") return "transcribe";
    if (["summary", "topics", "title.generate"].includes(kind))
        return "summary";
    return undefined;
}

/** Resolve the owner row that must be locked before queue deduplication. */
export function pipelineJobTarget(
    job: Pick<Job, "kind" | "userId" | "payload">,
    target?: PipelineJobTarget,
): PipelineJobTarget | undefined {
    if (target) return target;
    const phase = jobPhase(job.kind);
    if (!phase || typeof job.payload.recordingId !== "string") return;
    return {
        itemId: job.payload.recordingId,
        userId: job.userId,
        phase,
        ...(phase === "summary"
            ? {
                  step:
                      job.kind === "title.generate"
                          ? "title"
                          : (job.kind as SummaryStepName),
              }
            : {}),
    };
}

function compareCodeUnits(a: string, b: string): number {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

/** Lock order: item (when needed) → processing rows sorted by item/user id → profile locks sorted by owner id → job. */
export async function lockPipelineTargetsInTx(
    tx: Tx,
    targets: readonly Pick<PipelineJobTarget, "itemId" | "userId">[],
    create = false,
    skipLocked = false,
): Promise<boolean> {
    const ordered = [
        ...new Map(
            targets.map((target) => [
                JSON.stringify([target.itemId, target.userId]),
                target,
            ]),
        ).values(),
    ].sort(
        (a, b) =>
            compareCodeUnits(a.itemId, b.itemId) ||
            compareCodeUnits(a.userId, b.userId),
    );
    for (const target of ordered) {
        if (create) {
            const [item] = await tx
                .select({ id: chatterItems.id })
                .from(chatterItems)
                .where(
                    and(
                        eq(chatterItems.id, target.itemId),
                        eq(chatterItems.userId, target.userId),
                        isNull(chatterItems.deletedAt),
                    ),
                )
                .limit(1);
            if (!item) continue;
            await tx
                .insert(itemProcessing)
                .values({ ...target, view: "private" })
                .onConflictDoNothing();
        }
        const locked = await tx
            .select({ id: itemProcessing.itemId })
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, target.itemId),
                    eq(itemProcessing.userId, target.userId),
                    eq(itemProcessing.view, "private"),
                ),
            )
            .for("update", skipLocked ? { skipLocked: true } : {});
        if (skipLocked && locked.length === 0) {
            const [exists] = await tx
                .select({ id: itemProcessing.itemId })
                .from(itemProcessing)
                .where(
                    and(
                        eq(itemProcessing.itemId, target.itemId),
                        eq(itemProcessing.userId, target.userId),
                        eq(itemProcessing.view, "private"),
                    ),
                )
                .limit(1);
            if (exists) return false;
        }
    }
    return true;
}

/** Select bindings whose job and generation still match under the processing locks. */
export async function currentPipelineJobBindingsInTx(
    tx: Tx,
    job: Job,
): Promise<PipelineJobBinding[]> {
    const current: PipelineJobBinding[] = [];
    for (const binding of jobBindings(job.payload)) {
        const [processing] = await tx
            .select({ phases: itemProcessing.phases })
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, binding.itemId),
                    eq(itemProcessing.userId, binding.userId),
                    eq(itemProcessing.view, "private"),
                ),
            )
            .limit(1);
        const phase = processing?.phases[binding.phase];
        const step = binding.step ? phase?.steps?.[binding.step] : phase;
        if (step?.jobId === job.id && step.generation === binding.generation)
            current.push(binding);
    }
    return current;
}

function contentOf(
    transcript?: { id: string; revision: number; source: string },
    mail?: { id: string; revision: number },
): ContentRevisionInput | undefined {
    if (transcript)
        return {
            contentId: transcript.id,
            contentRevision: transcript.revision,
            contentSourceId: transcript.source,
        };
    if (mail)
        return {
            contentId: mail.id,
            contentRevision: mail.revision,
            contentSourceId: "mail",
        };
    return undefined;
}

function aggregateStepState(values: PhaseStepRecord[]): PhaseState {
    if (values.some((value) => value.state === "running")) return "running";
    if (values.some((value) => value.state === "failed")) return "failed";
    if (values.some((value) => value.state === "waiting")) return "waiting";
    const allSettled = values.every((value) =>
        ["done", "skipped"].includes(value.state ?? "pending"),
    );
    return allSettled ? "done" : "pending";
}

function aggregateStepReason(
    state: PhaseState,
    values: PhaseStepRecord[],
    fallback: string | undefined,
): string | undefined {
    if (state === "failed")
        return values.find((value) => value.state === "failed")?.reason;
    if (state === "done") return "completed";
    return fallback;
}

/** Bind a queued job to the owner's private step before the enqueue transaction commits. */
export async function bindPipelineJobInTx(
    tx: Tx,
    job: Job,
    target?: PipelineJobTarget,
    automaticRequest = false,
): Promise<void> {
    const phase = jobPhase(job.kind);
    if (!target && (!phase || typeof job.payload.recordingId !== "string"))
        return;
    const itemId = target?.itemId ?? String(job.payload.recordingId);
    const userId = target?.userId ?? job.userId;
    const driver = pipelineDriver(userId);
    const [item] = await tx
        .select({ id: chatterItems.id })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, itemId),
                eq(chatterItems.userId, userId),
                isNull(chatterItems.deletedAt),
            ),
        )
        .limit(1);
    if (!item) return;
    const automatic =
        target?.existingOnly !== true &&
        (automaticRequest ||
            target !== undefined ||
            job.payload.trigger !== "manual");
    if (automatic)
        await tx
            .insert(itemProcessing)
            .values({ itemId, ...driver })
            .onConflictDoNothing();
    const [processing] = await tx
        .select()
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, itemId),
                eq(itemProcessing.userId, userId),
                eq(itemProcessing.view, driver.view),
            ),
        )
        .for("update")
        .limit(1);
    if (!processing) return;
    const selected: PipelineJobTarget = target ?? {
        itemId,
        userId,
        phase: phase as PhaseName,
        ...(phase === "summary"
            ? {
                  step:
                      job.kind === "title.generate"
                          ? "title"
                          : (job.kind as SummaryStepName),
              }
            : {}),
    };
    const previous = processing.phases[selected.phase];
    const previousStep = selected.step
        ? previous?.steps?.[selected.step]
        : previous;
    if (!automatic && !previousStep) return;
    if (
        previousStep?.jobId === job.id &&
        jobBindings(job.payload).some((binding) =>
            sameBinding(binding, {
                ...selected,
                generation: previousStep.generation,
            }),
        )
    )
        return;
    let content = selected.record?.inputs ?? previous?.inputs;
    if (selected.phase === "learn" && typeof job.payload.runId === "string") {
        const [run] = await tx
            .select()
            .from(learnRuns)
            .where(
                and(
                    eq(learnRuns.id, job.payload.runId),
                    eq(learnRuns.userId, userId),
                ),
            )
            .limit(1);
        if (run && typeof run.inputs?.contentId === "string") {
            const [transcript] = run.transcriptionId
                ? await tx
                      .select({ source: transcriptions.source })
                      .from(transcriptions)
                      .where(
                          and(
                              eq(transcriptions.id, run.transcriptionId),
                              eq(transcriptions.userId, userId),
                          ),
                      )
                      .limit(1)
                : [];
            content = {
                contentId: run.inputs.contentId,
                contentRevision: run.transcriptRevision,
                contentSourceId: transcript?.source ?? "mail",
            };
        }
    }
    if ((selected.step || selected.phase === "learn") && !content) {
        const [transcript] = await tx
            .select({
                id: transcriptions.id,
                revision: transcriptions.revision,
                source: transcriptions.source,
            })
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, itemId),
                    eq(transcriptions.userId, userId),
                    eq(
                        transcriptions.source,
                        typeof job.payload.source === "string"
                            ? job.payload.source
                            : "riffado",
                    ),
                ),
            )
            .limit(1);
        const [mail] = transcript
            ? []
            : await tx
                  .select()
                  .from(mailContents)
                  .where(
                      and(
                          eq(mailContents.itemId, itemId),
                          eq(mailContents.userId, userId),
                      ),
                  )
                  .limit(1);
        content = contentOf(transcript, mail);
        if (!content && selected.step) return;
    }
    const bindTitle =
        selected.step === "summary" &&
        job.kind === "summary" &&
        (!previous?.steps?.title?.jobId ||
            previous.steps.title.state === "outdated") &&
        !automaticTitleSettled(processing.phases);
    const generation = Math.max(
        processing.requestedGeneration,
        (previousStep?.generation ?? 0) + 1,
        bindTitle ? (previous?.steps?.title?.generation ?? 0) + 1 : 0,
    );
    const record: PhaseRecord = {
        ...previous,
        ...selected.record,
        state: "running",
        replannedAt: undefined,
        replanAttempts: undefined,
        generation,
        reason:
            selected.phase === "transcribe"
                ? "automatic"
                : job.kind === "learn.correct"
                  ? "correcting"
                  : "started",
        at: new Date().toISOString(),
        ...(content ? { inputs: content } : {}),
        ...(selected.phase === "transcribe" ? { automatic } : {}),
    };
    const bindings = jobBindings(job.payload).filter(
        (binding) =>
            !(
                binding.itemId === itemId &&
                binding.userId === userId &&
                binding.phase === selected.phase &&
                binding.step === selected.step
            ),
    );
    const bind = (step?: SummaryStepName) => {
        bindings.push({
            itemId,
            userId,
            phase: selected.phase,
            ...(step ? { step } : {}),
            generation,
        });
        if (step && content) {
            record.steps = {
                ...record.steps,
                [step]: {
                    ...record.steps?.[step],
                    ...content,
                    state: "running",
                    at: new Date().toISOString(),
                    replannedAt: undefined,
                    replanAttempts: undefined,
                    reason: "started",
                    jobId: job.id,
                    generation,
                    outcome: undefined,
                    waitingFor: undefined,
                    retryable: undefined,
                },
            };
        } else {
            record.jobId = job.id;
            record.outcome = undefined;
            record.waitingFor = undefined;
            record.retryable = undefined;
        }
    };
    bind(selected.step);
    if (bindTitle) bind("title");
    await tx
        .update(itemProcessing)
        .set({
            phases: { ...processing.phases, [selected.phase]: record },
            requestedGeneration: Math.max(
                processing.requestedGeneration,
                generation,
            ),
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(itemProcessing.itemId, itemId),
                eq(itemProcessing.userId, userId),
                eq(itemProcessing.view, driver.view),
            ),
        );
    await tx
        .update(asyncJobs)
        .set({ payload: { ...job.payload, pipelineSteps: bindings } })
        .where(and(eq(asyncJobs.id, job.id), eq(asyncJobs.userId, job.userId)));
}

/** Persist a planner wake-up alongside a settled step. */
export async function wakePipelineInTx(
    tx: Tx,
    itemId: string,
    userId: string,
): Promise<void> {
    await tx.execute(sql`
        update item_processing set requested_generation = requested_generation + 1, updated_at = now()
        where item_id = ${itemId} and user_id = ${userId} and view = 'private'
    `);
    await tx
        .insert(asyncJobs)
        .values({
            userId,
            kind: "pipeline.advance",
            subjectId: itemId,
            maxAttempts: 10,
            payload: { itemId, view: "private", reason: "step-settled" },
        })
        .onConflictDoNothing({
            target: [asyncJobs.kind, asyncJobs.subjectId],
            where: sql`${asyncJobs.status} in ('pending', 'processing')`,
        });
}

/** Apply an outcome only to the exact job and generation still named by a step. */
export async function settlePipelineBindingInTx(
    tx: Tx,
    binding: PipelineJobBinding,
    jobId: string,
    outcome: StepOutcome,
): Promise<boolean> {
    const driver = pipelineDriver(binding.userId);
    const [processing] = await tx
        .select()
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, binding.itemId),
                eq(itemProcessing.userId, binding.userId),
                eq(itemProcessing.view, driver.view),
            ),
        )
        .for("update")
        .limit(1);
    const phase = processing?.phases[binding.phase];
    const step = binding.step ? phase?.steps?.[binding.step] : phase;
    if (
        !processing ||
        !phase ||
        step?.jobId !== jobId ||
        step.generation !== binding.generation
    ) {
        console.debug("[pipeline] superseded step settlement", {
            jobId,
            itemId: binding.itemId,
            generation: binding.generation,
        });
        return false;
    }
    if (
        binding.step === "summary" &&
        outcome.kind === "done" &&
        outcome.inputFingerprint === undefined
    ) {
        const [output] = await tx
            .select({ fingerprint: aiEnhancements.inputFingerprint })
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.itemId, binding.itemId),
                    eq(aiEnhancements.userId, binding.userId),
                    eq(aiEnhancements.source, "riffado"),
                ),
            )
            .limit(1);
        if (output)
            outcome = { ...outcome, inputFingerprint: output.fingerprint };
    }
    const settled = {
        ...step,
        ...outcomeRecord(outcome),
        outcome,
        jobId: undefined,
        retryable: outcome.kind === "failed" ? outcome.retryable : undefined,
        waitingFor: outcome.kind === "waiting" ? outcome.waitingFor : undefined,
    };
    let next: PhaseRecord;
    if (binding.step) {
        const steps = { ...phase.steps, [binding.step]: settled };
        const current = Object.values(steps).filter(
            (value) =>
                !phase.inputs ||
                (value.contentId === phase.inputs.contentId &&
                    value.contentRevision === phase.inputs.contentRevision &&
                    (value.contentSourceId ?? phase.inputs.contentSourceId) ===
                        phase.inputs.contentSourceId),
        );
        const state = aggregateStepState(current);
        next = {
            ...phase,
            steps,
            state,
            reason: aggregateStepReason(state, current, phase.reason),
            at: new Date().toISOString(),
        };
    } else {
        next = { ...phase, ...settled, at: new Date().toISOString() };
    }
    const phases: PipelinePhases = {
        ...processing.phases,
        [binding.phase]: next,
    };
    const held = phases.categorize?.heldProfiles;
    if (held && phases.categorize) {
        phases.categorize = {
            ...phases.categorize,
            heldProfiles: Object.fromEntries(
                Object.entries(held).filter(
                    ([, value]) => value.jobId !== jobId,
                ),
            ),
        };
    }
    await tx
        .update(itemProcessing)
        .set({ phases, updatedAt: new Date() })
        .where(
            and(
                eq(itemProcessing.itemId, binding.itemId),
                eq(itemProcessing.userId, binding.userId),
                eq(itemProcessing.view, driver.view),
            ),
        );
    if (!(binding.phase === "share" && outcome.kind === "waiting"))
        await wakePipelineInTx(tx, binding.itemId, binding.userId);
    return true;
}

/** Resolve terminal job metadata, including jobs completed by a previous deployment. */
export function terminalStepOutcome(
    job: Pick<Job, "status" | "result" | "errorCode">,
): StepOutcome {
    const outcome = job.result?.outcome;
    if (
        outcome &&
        typeof outcome === "object" &&
        "kind" in outcome &&
        ["done", "skipped", "waiting", "failed"].includes(String(outcome.kind))
    )
        return outcome as StepOutcome;
    if (job.status === "failed")
        return {
            kind: "failed",
            code: job.errorCode ?? "INTERNAL_ERROR",
            retryable: true,
        };
    if (typeof job.result?.skipped === "string")
        return { kind: "skipped", reason: job.result.skipped };
    return { kind: "done" };
}

/** Transfer a released Learn step to its queued correction pass, if present. */
export async function bindAvailableCorrectionInTx(
    tx: Tx,
    itemId: string,
    userId: string,
): Promise<void> {
    const [processing] = await tx
        .select({ phases: itemProcessing.phases })
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, itemId),
                eq(itemProcessing.userId, userId),
                eq(itemProcessing.view, "private"),
            ),
        )
        .for("update")
        .limit(1);
    if (!processing?.phases.learn || processing.phases.learn.jobId) return;
    const [next] = await tx
        .select({ job: asyncJobs })
        .from(asyncJobs)
        .innerJoin(
            transcriptCorrectionPasses,
            and(
                eq(transcriptCorrectionPasses.userId, userId),
                eq(transcriptCorrectionPasses.recordingId, itemId),
                eq(transcriptCorrectionPasses.actorUserId, asyncJobs.userId),
                sql`${asyncJobs.payload} ->> 'passId' = ${transcriptCorrectionPasses.id}`,
            ),
        )
        .where(
            and(
                eq(asyncJobs.kind, "learn.correct"),
                sql`${asyncJobs.status} in ('pending', 'processing')`,
            ),
        )
        .for("update", { of: asyncJobs, skipLocked: true })
        .limit(1);
    if (next)
        await bindPipelineJobInTx(tx, next.job, {
            itemId,
            userId,
            phase: "learn",
        });
}

/** Clear only interrupted steps before the owner's existing retry action replans them. */
export async function retryLostPipelineStepsInTx(
    tx: Tx,
    itemId: string,
    userId: string,
): Promise<number> {
    const [processing] = await tx
        .select({ phases: itemProcessing.phases })
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, itemId),
                eq(itemProcessing.userId, userId),
                eq(itemProcessing.view, "private"),
            ),
        )
        .for("update")
        .limit(1);
    if (!processing) return 0;
    const phases = { ...processing.phases };
    let cleared = 0;
    for (const name of Object.keys(phases) as PhaseName[]) {
        const phase = phases[name];
        if (!phase) continue;
        if (phase.steps) {
            const steps = { ...phase.steps };
            let changed = false;
            for (const step of Object.keys(steps) as SummaryStepName[])
                if (
                    steps[step]?.state === "failed" &&
                    steps[step]?.reason === "lost"
                ) {
                    delete steps[step];
                    cleared++;
                    changed = true;
                }
            if (changed) phases[name] = { ...phase, steps, state: "pending" };
        } else if (phase.state === "failed" && phase.reason === "lost") {
            delete phases[name];
            cleared++;
        }
    }
    if (cleared)
        await tx
            .update(itemProcessing)
            .set({ phases, updatedAt: new Date() })
            .where(
                and(
                    eq(itemProcessing.itemId, itemId),
                    eq(itemProcessing.userId, userId),
                    eq(itemProcessing.view, "private"),
                ),
            );
    return cleared;
}
