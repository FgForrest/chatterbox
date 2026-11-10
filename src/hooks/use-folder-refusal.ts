"use client";

import { useExtracted } from "next-intl";
import { useCallback } from "react";
import type { ApiErrorBody } from "@/lib/api-errors";

/** Localize the leaf-folder refusals shared by folder creation, movement and invitations. */
export function useFolderRefusal() {
    const i18n = useExtracted();
    return useCallback(
        (error: ApiErrorBody): string | null => {
            if (error.code === "SHARED_FOLDER_HAS_NO_SUBFOLDERS")
                return i18n("A shared folder has no subfolders.");
            if (error.code === "FOLDER_HAS_SUBFOLDERS")
                return i18n(
                    "Move this folder's subfolders elsewhere first. A shared folder has no subfolders.",
                );
            return null;
        },
        [i18n],
    );
}
