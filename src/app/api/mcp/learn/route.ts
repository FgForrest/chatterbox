import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { learnRuns } from "@/db/schema";
import { handleLearnMcp, readMcpBody } from "@/lib/learn/mcp";
import { verifyLearnRunToken } from "@/lib/learn/run-token";

/**
 * Riffado's read-only knowledge tools for a Learn run's model (MCP over
 * HTTP, stateless JSON-RPC). The only credential is the run's token
 * (`Authorization: Bearer`), valid while the run is running: anything else
 * is 401, with nothing said about why. A body is read only for a valid
 * token, and no further than its limit (413).
 */
export async function POST(request: Request): Promise<Response> {
    const unauthorized = () =>
        NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const runId = token ? verifyLearnRunToken(token) : null;
    if (!runId) return unauthorized();
    const [run] = await db
        .select({
            id: learnRuns.id,
            userId: learnRuns.userId,
            view: learnRuns.view,
        })
        .from(learnRuns)
        .where(and(eq(learnRuns.id, runId), eq(learnRuns.status, "running")))
        .limit(1);
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
