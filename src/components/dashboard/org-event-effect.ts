import type { OrgClientEvent } from "@/lib/events/types";
import type { RecordingView } from "@/lib/sharing/view";

/** Decide which visible data an Organization invalidation needs to reload. */
export function orgEventEffect(
    event: OrgClientEvent,
    current: { id: string; view?: RecordingView } | null,
    libraryIds: ReadonlySet<string>,
    origin: string,
): { refresh: boolean; refetchContent: boolean } {
    if (event.type === "tree") return { refresh: true, refetchContent: false };
    const onScreen = current?.id === event.recordingId;
    if (!libraryIds.has(event.recordingId) || event.origin === origin) {
        return { refresh: false, refetchContent: false };
    }
    return {
        refresh: true,
        refetchContent: onScreen && current?.view === "org",
    };
}
