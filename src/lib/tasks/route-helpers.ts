import { requireApiSession } from "@/lib/auth-server";
import { AppError, ErrorCode } from "@/lib/errors";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { type TaskViewer, taskViewer } from "@/lib/tasks/access";

/** A task change is a few short fields; nothing near this. */
const MAX_BODY_BYTES = 16 * 1024;

/** The signed-in caller, as tasks see them. */
export async function requireTaskViewer(request: Request): Promise<TaskViewer> {
    const session = await requireApiSession(request);
    return taskViewer({ id: session.user.id, email: session.user.email });
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
