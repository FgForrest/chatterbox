import { env } from "@/lib/env";

/**
 * Where a person opens a recording in Riffado: the dashboard, in the
 * Organization library for `view: "org"`.
 */
export function recordingUrl(id: string, view: "private" | "org"): string {
    const query = new URLSearchParams({ recording: id });
    if (view === "org") query.set("view", "org");
    return `${(env.APP_URL ?? "").replace(/\/+$/, "")}/dashboard?${query}`;
}
