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
            if (error.code === "RESTRICTED_FOLDER_LEAF")
                return i18n("A restricted folder has no subfolders.");
            if (error.code === "RESTRICTED_FOLDER_HAS_CHILDREN")
                return i18n(
                    "Move this folder's subfolders elsewhere first. A restricted folder has no subfolders.",
                );
            if (error.code === "RESTRICTED_FOLDER_NO_ACCESS")
                return i18n(
                    "You no longer have access to this restricted folder.",
                );
            if (error.code === "RESTRICTED_FOLDER_REQUEST_NOT_PENDING")
                return i18n(
                    "This request has already been decided. The list has been refreshed.",
                );
            if (error.code === "RESTRICTED_FOLDER_EXPORT")
                return i18n(
                    "Restricted folders cannot be exported for the Organization.",
                );
            if (error.code === "UNIQUE_CONSTRAINT_VIOLATION")
                return i18n("A folder with this name already exists here.");
            if (error.code === "FORBIDDEN")
                return i18n("You no longer have permission for this action.");
            if (
                error.code === "RATE_LIMITED" ||
                error.code === "RATE_LIMIT_EXCEEDED"
            )
                return i18n("Too many requests. Please try again shortly.");
            return null;
        },
        [i18n],
    );
}
