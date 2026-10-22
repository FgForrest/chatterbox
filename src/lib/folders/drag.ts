import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

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

export function canManageOrganization(
    canCurate: boolean,
    isOrgAccount: boolean,
): boolean {
    return canCurate || isOrgAccount;
}

export function recordingDropEffect(
    types: readonly string[],
    scope: RecordingFolder["scope"],
    canMove = true,
    canCurate = false,
    isOrgAccount = false,
): "move" | "copy" | "none" {
    if (
        types.includes(RECORDING_OTHER_OWNER_DRAG_TYPE) &&
        (scope !== "org" || !canManageOrganization(canCurate, isOrgAccount))
    )
        return "none";
    return canMove && types.includes(RECORDING_SOURCE_SCOPE_DRAG_TYPES[scope])
        ? "move"
        : "copy";
}

export function canFileRecording(
    recording: Recording,
    canCurate = false,
    isOrgAccount = false,
): boolean {
    return (
        recording.isOwn !== false ||
        canManageOrganization(canCurate, isOrgAccount)
    );
}
