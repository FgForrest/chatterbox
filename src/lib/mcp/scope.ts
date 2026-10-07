import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import { recordings } from "@/db/schema";
import type { ReadContext } from "@/lib/knowledge/scope";
import type { McpCaller } from "@/lib/mcp/caller";
import { sharedRecordingCondition } from "@/lib/sharing/shared";
import type { RecordingView } from "@/lib/sharing/view";
import {
    type TaskViewer,
    taskViewer,
    taskViewerById,
} from "@/lib/tasks/access";

/**
 * SQL over `recordings`: the recordings this caller may read, as the
 * recordings list shows them. A user reads their own and the
 * Organization-shared ones; a service caller the shared ones alone.
 * Deleted recordings are never readable.
 */
export function mcpRecordingCondition(caller: McpCaller): SQL {
    const shared = caller.orgUserId
        ? sharedRecordingCondition(caller.orgUserId)
        : undefined;
    const visible =
        caller.kind === "service"
            ? shared
            : shared
              ? or(eq(recordings.userId, caller.userId), shared)
              : eq(recordings.userId, caller.userId);
    return and(isNull(recordings.deletedAt), visible) as SQL;
}

/**
 * The view a caller reads a recording in: the owner's private one for
 * their own recording, the Organization's for anything else.
 */
export function recordingViewFor(
    caller: McpCaller,
    ownerUserId: string,
): RecordingView {
    return caller.kind === "user" && caller.userId === ownerUserId
        ? "private"
        : "org";
}

/**
 * The knowledge a caller reads: a user their own and the Organization's,
 * a service caller the Organization's alone.
 */
export function knowledgeContextFor(caller: McpCaller): ReadContext {
    return {
        kind: "pages",
        viewerUserId: caller.kind === "user" ? caller.userId : caller.orgUserId,
    };
}

/**
 * The task viewer a caller acts as: the user, or the Organization account
 * for a service caller.
 */
export function taskViewerFor(caller: McpCaller): Promise<TaskViewer> {
    return caller.kind === "user"
        ? taskViewer({ id: caller.userId, email: caller.email })
        : taskViewerById(caller.orgUserId);
}
