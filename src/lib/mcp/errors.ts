import type { McpOutcome } from "@/lib/mcp/audit";

/**
 * A tool failure the caller may see: a fixed message, optional details
 * safe to return, and the outcome the access log records.
 */
export class McpToolError extends Error {
    readonly outcome: McpOutcome;
    readonly details: unknown;

    constructor(
        message: string,
        outcome: McpOutcome = "invalid",
        details?: unknown,
    ) {
        super(message);
        this.name = "McpToolError";
        this.outcome = outcome;
        this.details = details;
    }
}

/** What a tool answers for a row that is missing or not the caller's to read. */
export function notFound(): McpToolError {
    return new McpToolError("Not found", "not_found");
}
