import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import {
    learnRuns,
    transcriptCorrectionPasses,
    transcriptions,
} from "@/db/schema";
import { handleLearnMcp, type McpRun, readMcpBody } from "@/lib/learn/mcp";
import {
    verifyCorrectionPassToken,
    verifyLearnRunToken,
} from "@/lib/learn/run-token";

/**
 * Riffado's read-only knowledge tools for a Learn run's model, or a
 * correction pass's (MCP over HTTP, stateless JSON-RPC). The only
 * credential is the run's or the pass's token (`Authorization: Bearer`),
 * valid while it is running: anything else is 401, with nothing said
 * about why. A body is read only for a valid token, and no further than
 * its limit (413).
 */
export async function POST(request: Request): Promise<Response> {
    const unauthorized = () =>
        NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const run = token ? await runOf(token) : null;
    if (!run) return unauthorized();

    const read = await readMcpBody(request);
    if (read.tooLarge) {
        return NextResponse.json(
            { error: "Request too large" },
            { status: 413 },
        );
    }
    const answer = await handleLearnMcp(read.body, run);
    if (!answer) return new Response(null, { status: 202 });
    return NextResponse.json(answer);
}

/** The running Learn run or correction pass a token names, if any. */
async function runOf(token: string): Promise<McpRun | null> {
    const runId = verifyLearnRunToken(token);
    if (runId) {
        const [run] = await db
            .select({
                id: learnRuns.id,
                userId: learnRuns.userId,
                view: learnRuns.view,
                language: transcriptions.detectedLanguage,
            })
            .from(learnRuns)
            .innerJoin(
                transcriptions,
                eq(transcriptions.id, learnRuns.transcriptionId),
            )
            .where(
                and(eq(learnRuns.id, runId), eq(learnRuns.status, "running")),
            )
            .limit(1);
        return run ? { ...run, kind: "learn" } : null;
    }
    const passId = verifyCorrectionPassToken(token);
    if (!passId) return null;
    const passes = transcriptCorrectionPasses;
    const [pass] = await db
        .select({
            id: passes.id,
            userId: passes.userId,
            view: passes.view,
            language: transcriptions.detectedLanguage,
        })
        .from(passes)
        .innerJoin(
            transcriptions,
            eq(transcriptions.id, passes.transcriptionId),
        )
        .where(and(eq(passes.id, passId), eq(passes.status, "running")))
        .limit(1);
    return pass ? { ...pass, kind: "correction" } : null;
}
