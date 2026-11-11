"use client";

import { useExtracted } from "next-intl";
import { useCallback } from "react";
import type { ApiErrorBody } from "@/lib/api-errors";

/** Explain durable copy-removal obligations without removing their configuration. */
export function useExportRefusal() {
    const i18n = useExtracted();
    return useCallback(
        (
            error: ApiErrorBody,
        ): { message: string; retryable: boolean } | null => {
            if (error.code === "EXPORT_LOCK_BUSY")
                return {
                    message: i18n("An export is busy. Retry when it finishes."),
                    retryable: true,
                };
            if (error.code === "EXPORT_REVOCATION_PENDING")
                return {
                    message: i18n(
                        "Restricted copies are still being removed. Retry shortly.",
                    ),
                    retryable: true,
                };
            if (error.code !== "EXPORT_REVOCATION_BLOCKED") return null;
            let message: string;
            switch (error.details?.cause) {
                case "not_connected":
                    message = i18n("No Google account is connected.");
                    break;
                case "needs_reconnect":
                    message = i18n("The Google account must be reconnected");
                    break;
                case "missing_scope":
                    message = i18n(
                        "Google Drive access was not granted. Connect again and allow it.",
                    );
                    break;
                case "account_mismatch":
                    message = i18n(
                        "Use the same Google account already connected here.",
                    );
                    break;
                case "not_configured":
                    message = i18n("The Google integration is not configured");
                    break;
                case "target_missing":
                case "target_lost":
                    message = i18n(
                        "The export target is unavailable. Choose the target again before retrying copy removal.",
                    );
                    break;
                case "provider_unavailable":
                    message = i18n(
                        "The export provider is unavailable. Restore its configuration before retrying copy removal.",
                    );
                    break;
                default:
                    message = i18n(
                        "Copy removal was refused. Check the export target's permissions and retry.",
                    );
            }
            return { message, retryable: false };
        },
        [i18n],
    );
}
