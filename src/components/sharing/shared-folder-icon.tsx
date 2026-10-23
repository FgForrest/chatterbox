import { Folder, FolderInput, FolderOutput } from "lucide-react";
import type { LabelledFolder } from "@/lib/folders/labels";
import { cn } from "@/lib/utils";

/** Shared folder marks for tree rows, navigation results and filing pickers. */
export function SharedFolderIcon({
    folder,
    className,
}: {
    folder: LabelledFolder;
    className?: string;
}) {
    const Icon = folder.receivedFolder
        ? FolderInput
        : folder.sharedWithPeople
          ? FolderOutput
          : Folder;
    return (
        <Icon
            aria-hidden
            className={cn(
                "size-4 shrink-0",
                folder.receivedFolder || folder.sharedWithPeople
                    ? "text-person-share"
                    : folder.scope === "org"
                      ? "text-organization"
                      : "text-primary",
                className,
            )}
        />
    );
}
