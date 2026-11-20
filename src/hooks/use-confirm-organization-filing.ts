"use client";

import { useExtracted } from "next-intl";
import { useCallback } from "react";
import { useOptionalConfirm } from "@/components/confirm-dialog";
import type { RecordingFolder } from "@/types/folder";

/** Confirm publication when an item with a restricted placement is filed openly. */
export function useConfirmOrganizationFiling(
    folders: RecordingFolder[],
    getFolderIds: (itemId: string) => readonly string[],
) {
    const i18n = useExtracted();
    const confirm = useOptionalConfirm();
    return useCallback(
        (itemId: string, folderId: string) => {
            const target = folders.find((folder) => folder.id === folderId);
            const assignedIds = new Set(getFolderIds(itemId));
            const restrictedSource = folders.some(
                (folder) =>
                    assignedIds.has(folder.id) &&
                    (folder.restricted || folder.restricting),
            );
            const published = folders.some(
                (folder) =>
                    assignedIds.has(folder.id) &&
                    folder.scope === "org" &&
                    !folder.restricted &&
                    !folder.restricting,
            );
            if (
                !restrictedSource ||
                published ||
                target?.scope !== "org" ||
                target.restricted ||
                target.restricting
            )
                return false;
            if (!confirm) throw new Error(i18n("Filing cancelled"));
            return confirm({
                title: i18n("Share with the whole Organization?"),
                description: i18n(
                    "Speaker names and facts reach the Organization Almanac. The item stays in the restricted folder too.",
                ),
                confirmLabel: i18n("Share with the Organization"),
                onConfirm: () => {},
            }).then((confirmed) => {
                if (!confirmed) throw new Error(i18n("Filing cancelled"));
                return true as const;
            });
        },
        [getFolderIds, folders, confirm, i18n],
    );
}
