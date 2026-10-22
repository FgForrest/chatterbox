import { canManageOrganization } from "@/lib/folders/drag";
import type { RecordingFolder } from "@/types/folder";

/** Whether the viewer can create a child in this folder. */
export function canCreateSubfolder(
    folder: RecordingFolder,
    canCurate = false,
    isOrgAccount = false,
): boolean {
    return (
        folder.scope !== "org" ||
        folder.parentId !== null ||
        canManageOrganization(canCurate, isOrgAccount)
    );
}
