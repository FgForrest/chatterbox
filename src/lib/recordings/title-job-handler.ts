import type { JobHandler } from "@/lib/jobs/types";
import type { PipelineJobResult } from "@/lib/pipeline/outcome";
import {
    parseTitleJobPayload,
    TITLE_JOB_KIND,
    type TitleJobPayload,
} from "@/lib/recordings/title-job";

/** Drain title jobs queued before titles moved behind the first summary. */
export const titleJobHandler: JobHandler<TitleJobPayload> = {
    kind: TITLE_JOB_KIND,
    concurrency: 1,
    maxAttempts: 3,
    timeoutMs: 5 * 60 * 1000,
    backoff: { baseMs: 30_000, maxMs: 10 * 60_000, jitter: 0.3 },
    parsePayload: parseTitleJobPayload,

    async run(): Promise<PipelineJobResult> {
        return {
            skipped: "superseded",
            outcome: { kind: "skipped", reason: "superseded" },
        };
    },
};
