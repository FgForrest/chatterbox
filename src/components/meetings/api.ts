import { parseApiError } from "@/lib/api-errors";
import type { MeetingDetail } from "./types";

export async function meetingRequest<T>(
    url: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
): Promise<T> {
    const response = await fetch(url, {
        method,
        signal,
        ...(body === undefined
            ? {}
            : {
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(body),
              }),
    });
    if (!response.ok) {
        const error = await parseApiError(response);
        throw Object.assign(new Error(error.error), {
            status: response.status,
            code: error.code,
            reason: error.details?.reason,
        });
    }
    return response.status === 204
        ? (undefined as T)
        : ((await response.json()) as T);
}
export function meetingUrl(id: string, path = "") {
    return `/api/meetings/${encodeURIComponent(id)}${path}`;
}

const prewarmed = new Map<
    string,
    { at: number; value: Promise<MeetingDetail> }
>();
export function prewarmAgenda(id: string) {
    const previous = prewarmed.get(id);
    if (previous && Date.now() - previous.at < 15000) return;
    const value = meetingRequest<MeetingDetail>(meetingUrl(id));
    prewarmed.set(id, { at: Date.now(), value });
    void value.catch(() => prewarmed.delete(id));
    if (prewarmed.size > 30)
        prewarmed.delete(prewarmed.keys().next().value ?? "");
}
export function takePrewarmedAgenda(id: string): Promise<MeetingDetail> | null {
    const cached = prewarmed.get(id);
    prewarmed.delete(id);
    return cached && Date.now() - cached.at < 15000 ? cached.value : null;
}

export function recordingAudienceConflict(error: unknown): boolean {
    return (
        error instanceof Error &&
        "reason" in error &&
        error.reason === "recording_audience_exceeds_agenda"
    );
}
