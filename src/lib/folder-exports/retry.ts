import {
    GoogleApiError,
    GoogleConnectionUnavailableError,
} from "@/lib/integrations/google/errors";
import { isRetryableError } from "@/lib/jobs/retryable";
import { DriveTargetLostError } from "./drive-provider";
import { ExportPathTakenError } from "./filesystem-provider";

/**
 * Export jobs retry transient failures only. A missing or revoked Google
 * account, a lost Drive folder and someone's file in the export's way wait
 * for the user: reconnecting, editing or synchronizing plans it again.
 */
export function isExportErrorRetryable(error: unknown): boolean {
    if (
        error instanceof GoogleConnectionUnavailableError ||
        error instanceof DriveTargetLostError ||
        error instanceof ExportPathTakenError
    ) {
        return false;
    }
    if (error instanceof GoogleApiError) {
        return error.retryable || error.status === 401;
    }
    return isRetryableError(error);
}
