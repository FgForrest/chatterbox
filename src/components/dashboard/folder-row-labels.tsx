"use client";

import { SharedFolderIcon } from "@/components/sharing/shared-folder-icon";
import { useFolderLabel } from "@/hooks/use-folder-label";
import type { RecordingFolder } from "@/types/folder";

/** Folder labels shared by recording, mail and agenda list rows. */
export function FolderRowLabels({ folders }: { folders: RecordingFolder[] }) {
    const label = useFolderLabel();
    return folders.map((folder, index) => (
        <span
            key={folder.id}
            className="inline-flex min-w-0 items-center gap-1"
        >
            {index > 0 && <span>, </span>}
            <SharedFolderIcon folder={folder} className="size-3" />
            <span className="truncate">{label(folder)}</span>
        </span>
    ));
}
