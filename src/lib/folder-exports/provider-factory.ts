import { deploymentProductName } from "@/lib/deployment-brand";
import { env } from "@/lib/env";
import { defaultLocale } from "@/lib/i18n/config";
import {
    getGoogleAccessToken,
    googleAccessTokenSource,
    invalidateGoogleAccessToken,
} from "@/lib/integrations/google/connection";
import { createDriveClient } from "@/lib/integrations/google/drive-client";
import { DbDriveNodeStore } from "./drive-nodes";
import {
    DriveExportProvider,
    managedFolderDescription,
} from "./drive-provider";
import { DbFilesystemNodeStore } from "./filesystem-nodes";
import { FilesystemExportProvider } from "./filesystem-provider";
import type { ExportTarget } from "./target";
import type { ExportProvider } from "./types";

/**
 * The provider writing `target`. A Drive export fails here, before any
 * work, when its Google account is not usable.
 */
export async function createExportProvider(
    target: ExportTarget,
): Promise<ExportProvider> {
    switch (target.provider) {
        case "filesystem":
            return new FilesystemExportProvider(
                env.FILESYSTEM_EXPORT_ROOT ?? "",
                new DbFilesystemNodeStore(target.userId, target.id),
                deploymentProductName(defaultLocale),
            );
        case "google-drive": {
            const drive = target.googleDrive;
            if (!drive) throw new Error("Google Drive export has no settings");
            await getGoogleAccessToken(target.userId, {
                expectedSubject: drive.accountSubject,
            });
            return new DriveExportProvider({
                exportId: target.id,
                rootFolderId: drive.rootFolderId,
                client: createDriveClient({
                    driveId: drive.driveId,
                    getAccessToken: googleAccessTokenSource(
                        target.userId,
                        drive.accountSubject,
                    ),
                    onUnauthorized: () =>
                        invalidateGoogleAccessToken(target.userId),
                }),
                nodes: new DbDriveNodeStore(target.userId, target.id),
                managedFolderDescription: managedFolderDescription(
                    deploymentProductName(defaultLocale),
                ),
            });
        }
    }
}
