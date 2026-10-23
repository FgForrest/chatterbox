import { env } from "@/lib/env";

/**
 * Where a person opens a recording in Riffado: the dashboard, in the
 * Organization library for `view: "org"`.
 */
export function recordingUrl(
    id: string,
    view: "private" | "org" | "received",
): string {
    const query = new URLSearchParams({ recording: id });
    if (view !== "private") query.set("view", view);
    return `${(env.APP_URL ?? "").replace(/\/+$/, "")}/dashboard?${query}`;
}
