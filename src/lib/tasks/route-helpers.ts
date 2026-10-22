import { requireApiSessionActor } from "@/lib/auth-server";
import { AppError, ErrorCode } from "@/lib/errors";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
import { requireRecordingAccess } from "@/lib/sharing/access";
import { type TaskViewer, taskViewer } from "@/lib/tasks/access";

/** A task change is a few short fields; nothing near this. */
const MAX_BODY_BYTES = 16 * 1024;

/** The signed-in caller, as tasks see them. */
export async function requireTaskViewer(request: Request): Promise<TaskViewer> {
    const { session, actor } = await requireApiSessionActor(request);
    const item = new URL(request.url).pathname.match(
        /^\/api\/recordings\/([^/]+)\/tasks(?:\/|$)/,
    );
    if (request.method !== "GET" && item) {
        const access = await requireRecordingAccess(
            session.user.id,
            decodeURIComponent(item[1]),
            { kinds: ["audio", "mail"] },
        );
        if (access.role === "receiver")
            throw new AppError(
                ErrorCode.FORBIDDEN,
                "Received items are read-only",
                403,
            );
    }
    return taskViewer(
        { id: session.user.id, email: session.user.email },
        actor,
    );
}

/** The request's JSON object, or a 400/413. */
export async function readTaskBody(
    request: Request,
): Promise<Record<string, unknown>> {
    const read = await readBoundedJson(request, MAX_BODY_BYTES);
    if (read.tooLarge) {
        throw new AppError(ErrorCode.INVALID_INPUT, "Request too large", 413);
    }
    const body = read.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw invalid("A JSON object is required");
    }
    return body as Record<string, unknown>;
}

export function invalid(message: string, field?: string): AppError {
    return new AppError(
        ErrorCode.INVALID_INPUT,
        message,
        400,
        field ? { field } : undefined,
    );
}

/** A required non-negative integer `version`. */
export function readVersion(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw invalid("version is required", "version");
    }
    return value;
}

/** An optional `string | null` field: undefined when absent. */
export function optionalNullableString(
    body: Record<string, unknown>,
    field: string,
): string | null | undefined {
    const value = body[field];
    if (value === undefined) return undefined;
    if (value === null || typeof value === "string") return value;
    throw invalid(`${field} must be a string or null`, field);
}

/** Bound repeated full-scope merge searches for one signed-in user. */
export async function enforceTaskMergeSearchRateLimit(
    viewer: TaskViewer,
): Promise<void> {
    const result = await consumeRateLimitBucket(
        `tasks:merge-search:user:${viewer.userId}`,
        { limit: 60, windowMs: 60_000 },
    );
    if (result.allowed) return;
    const retryAfter = Math.max(
        1,
        Math.ceil((result.resetAt.getTime() - Date.now()) / 1_000),
    );
    throw new AppError(
        ErrorCode.RATE_LIMITED,
        "Too many task merge searches",
        429,
        { retryAfter },
    );
}

/** Bound task mutations for one signed-in user. */
export async function enforceTaskWriteRateLimit(
    viewer: TaskViewer,
): Promise<void> {
    const result = await consumeRateLimitBucket(
        `tasks:write:user:${viewer.userId}`,
        { limit: 120, windowMs: 60_000 },
    );
    if (result.allowed) return;
    const retryAfter = Math.max(
        1,
        Math.ceil((result.resetAt.getTime() - Date.now()) / 1_000),
    );
    throw new AppError(ErrorCode.RATE_LIMITED, "Too many task changes", 429, {
        retryAfter,
    });
}
