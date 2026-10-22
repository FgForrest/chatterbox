import type { RecordingFolder } from "@/types/folder";

export const RECORDING_DRAG_TYPE = "application/x-riffado-recording";
export const RECORDING_SOURCE_FOLDER_DRAG_TYPE =
    "application/x-riffado-recording-source-folder";
export const RECORDING_OTHER_OWNER_DRAG_TYPE =
    "application/x-riffado-recording-other-owner";
export const FOLDER_DRAG_TYPE = "application/x-riffado-folder";

export const RECORDING_SOURCE_SCOPE_DRAG_TYPES = {
    personal: "application/x-riffado-recording-source-personal",
    org: "application/x-riffado-recording-source-org",
} as const;

/** Whether the viewer manages Organization folders (a curator or the organization account). */
export function canManageOrganization(
    canCurate: boolean,
    isOrgAccount: boolean,
): boolean {
    return canCurate || isOrgAccount;
}

/** The drop effect for a dragged recording: moving within its scope, filing across, never a colleague's item into a personal folder. */
export function recordingDropEffect(
    types: readonly string[],
    scope: RecordingFolder["scope"],
    canMove = true,
): "move" | "copy" | "none" {
    if (types.includes(RECORDING_OTHER_OWNER_DRAG_TYPE) && scope !== "org")
        return "none";
    return canMove && types.includes(RECORDING_SOURCE_SCOPE_DRAG_TYPES[scope])
        ? "move"
        : "copy";
}
