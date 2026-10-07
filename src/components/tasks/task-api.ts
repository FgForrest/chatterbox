"use client";

import { parseApiError } from "@/lib/api-errors";
import type {
    AcceptResult,
    RecordingTasks,
    TaskChange,
    TaskView,
} from "@/lib/tasks/tasks";

/** A refused task request: its message, and whether it lost a race. */
export class TaskRequestError extends Error {
    constructor(
        message: string,
        readonly conflict: boolean,
    ) {
        super(message);
    }
}

async function send<T>(
    url: string,
    init: RequestInit & { json?: unknown } = {},
): Promise<T> {
    const { json, ...rest } = init;
    const response = await fetch(url, {
        ...rest,
        headers:
            json === undefined
                ? rest.headers
                : { "content-type": "application/json", ...rest.headers },
        body: json === undefined ? rest.body : JSON.stringify(json),
    });
    if (!response.ok) {
        const body = await parseApiError(response);
        throw new TaskRequestError(body.error, response.status === 409);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
}

/** Tasks belong to the recording, whichever view shows it. */
function recordingUrl(recordingId: string, path = "") {
    return `/api/recordings/${encodeURIComponent(recordingId)}/tasks${path}`;
}

export function fetchRecordingTasks(
    recordingId: string,
): Promise<RecordingTasks> {
    return send(recordingUrl(recordingId));
}

export function changeTask(
    taskId: string,
    change: TaskChange,
): Promise<TaskView> {
    return send(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        json: change,
    });
}

export function rejectTaskProposal(
    taskId: string,
    version: number,
): Promise<void> {
    return send(`/api/tasks/${encodeURIComponent(taskId)}?version=${version}`, {
        method: "DELETE",
    });
}

export function addRecordingTask(
    recordingId: string,
    task: {
        text: string;
        assigneePersonId?: string | null;
        dueDate?: string | null;
        status: "proposed" | "open";
    },
): Promise<TaskView> {
    return send(recordingUrl(recordingId), { method: "POST", json: task });
}

export function mergeTaskProposals(
    recordingId: string,
    taskIds: string[],
): Promise<TaskView> {
    return send(recordingUrl(recordingId, "/merge"), {
        method: "POST",
        json: { taskIds },
    });
}

/** Accept the review the reviewer saw: its proposals' and follow-ups' ids. */
export function acceptTaskReview(
    recordingId: string,
    shown: { proposals: string[]; updates: string[] },
): Promise<AcceptResult> {
    return send(recordingUrl(recordingId, "/accept"), {
        method: "POST",
        json: shown,
    });
}

export function tickTaskUpdate(
    recordingId: string,
    updateId: string,
    ticked: boolean,
    version: number,
): Promise<void> {
    return send(
        recordingUrl(recordingId, `/updates/${encodeURIComponent(updateId)}`),
        { method: "PATCH", json: { ticked, version } },
    );
}

/** Tell whatever counts tasks (the nav badges) to count again. */
const TASKS_CHANGED = "riffado:tasks-changed";

export function announceTasksChanged(): void {
    window.dispatchEvent(new Event(TASKS_CHANGED));
}

export function onTasksChanged(listener: () => void): () => void {
    window.addEventListener(TASKS_CHANGED, listener);
    return () => window.removeEventListener(TASKS_CHANGED, listener);
}
