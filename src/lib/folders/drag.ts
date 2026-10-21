import type { RecordingFolder } from "@/types/folder";

export const RECORDING_DRAG_TYPE = "application/x-riffado-recording";
export const RECORDING_SOURCE_FOLDER_DRAG_TYPE =
    "application/x-riffado-recording-source-folder";
export const FOLDER_DRAG_TYPE = "application/x-riffado-folder";

export const RECORDING_SOURCE_SCOPE_DRAG_TYPES = {
    personal: "application/x-riffado-recording-source-personal",
    org: "application/x-riffado-recording-source-org",
} as const;

export function recordingDropEffect(
    types: readonly string[],
    scope: RecordingFolder["scope"],
    canMove = true,
): "move" | "copy" {
    return canMove && types.includes(RECORDING_SOURCE_SCOPE_DRAG_TYPES[scope])
        ? "move"
        : "copy";
}
