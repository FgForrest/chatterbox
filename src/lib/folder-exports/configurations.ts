import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
    filesystemExportSettings,
    folderExportConfigurations,
    googleDriveExportSettings,
    recordingFolders,
} from "@/db/schema";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import { resolveReadableFolder } from "@/lib/folders/folders";
import { applicableExportConfigurationIds } from "@/lib/folders/hierarchy";
import { isGoogleIntegrationAvailable } from "@/lib/integrations/google/config";
import { inspectDriveFolder } from "@/lib/integrations/google/drive-folders";
import { isMailEnabled } from "@/lib/mail/config";
import { assertOrgScopeWritable } from "@/lib/org/config";
import { validateRelativeExportPath } from "./filesystem-provider";
import { enqueueExportPlan } from "./jobs";
import { mayWriteOrganizationExport, WRITER_NO_LONGER_CURATOR } from "./scope";
import {
    type ExportTarget,
    listExportTargets,
    listOrganizationExportTargets,
    loadExportTarget,
    toConfigurationDto,
} from "./target";
import type {
    DocumentFormat,
    ExportProvidersAvailability,
    FolderExportConfigurationDto,
    FolderExportProviderType,
} from "./types";

interface SaveFolderExportCommon {
    exportAudio: boolean;
    exportTranscript: boolean;
    exportSummary: boolean;
    /** Absent: off on a new export, unchanged on an existing one. */
    exportMail?: boolean;
}

export type SaveFolderExportInput = SaveFolderExportCommon &
    (
        | { provider?: "filesystem"; targetPath: string }
        | {
              provider: "google-drive";
              rootFolderId: string;
              transcriptFormat: DocumentFormat;
              summaryFormat: DocumentFormat;
          }
    );

const DOCUMENT_FORMATS: ReadonlySet<string> = new Set([
    "markdown",
    "google_doc",
    "both",
]);

export function isDocumentFormat(value: unknown): value is DocumentFormat {
    return typeof value === "string" && DOCUMENT_FORMATS.has(value);
}

export function exportProvidersAvailability(): ExportProvidersAvailability {
    return {
        filesystem: !env.IS_HOSTED && Boolean(env.FILESYSTEM_EXPORT_ROOT),
        googleDrive: isGoogleIntegrationAvailable(),
        mail: isMailEnabled(),
    };
}

function assertProviderAvailable(provider: FolderExportProviderType): void {
    const available = exportProvidersAvailability();
    if (provider === "filesystem" && !available.filesystem) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Filesystem exports are not available on this deployment",
            404,
        );
    }
    if (provider === "google-drive" && !available.googleDrive) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Google Drive exports are not available on this deployment",
            404,
        );
    }
}

/** Folder exports exist on this deployment through at least one provider. */
export function assertFolderExportsAvailable(): void {
    const available = exportProvidersAvailability();
    if (!available.filesystem && !available.googleDrive) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Folder exports are not available on this deployment",
            404,
        );
    }
}

function validateSelection(selection: {
    exportAudio: boolean;
    exportTranscript: boolean;
    exportSummary: boolean;
    exportMail: boolean;
}): void {
    if (
        !selection.exportAudio &&
        !selection.exportTranscript &&
        !selection.exportSummary &&
        !selection.exportMail
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Enable at least one artifact type",
            400,
        );
    }
}

function providerOf(input: SaveFolderExportInput): FolderExportProviderType {
    return input.provider ?? "filesystem";
}

function filesystemTargetPath(targetPath: string): string {
    try {
        return validateRelativeExportPath(targetPath);
    } catch (error) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            error instanceof Error ? error.message : "Invalid export path",
            400,
            { field: "targetPath" },
        );
    }
}

/** Require a folder owned by the caller, regardless of its tree or writability. */
export async function assertOwnedFolder(
    userId: string,
    folderId: string,
): Promise<void> {
    const [folder] = await db
        .select({ id: recordingFolders.id })
        .from(recordingFolders)
        .where(
            and(
                eq(recordingFolders.userId, userId),
                eq(recordingFolders.id, folderId),
            ),
        )
        .limit(1);
    if (!folder) {
        throw new AppError(ErrorCode.NOT_FOUND, "Folder not found", 404);
    }
}

/** Require an owned Private folder or an Organization folder the caller curates. */
export async function assertExportableFolder(userId: string, folderId: string) {
    const access = await requireExportFolder(userId, folderId);
    if (access.scope === "org") {
        assertOrgScopeWritable();
        if (!(await mayWriteOrganizationExport(userId))) {
            throw new AppError(
                ErrorCode.FORBIDDEN,
                "Only curators may manage Organization folder exports",
                403,
            );
        }
    }
    const folders = await db
        .select({
            id: recordingFolders.id,
            parentId: recordingFolders.parentId,
            kind: recordingFolders.kind,
        })
        .from(recordingFolders)
        .where(eq(recordingFolders.userId, access.ownerId));
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    let current = byId.get(folderId);
    while (current?.parentId) current = byId.get(current.parentId);
    if (current?.kind !== (access.scope === "org" ? "public" : "private")) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Exports can only be configured in Private or Organization folders",
            400,
        );
    }
    return access;
}

async function requireExportFolder(userId: string, folderId: string) {
    const access = await resolveReadableFolder(userId, folderId);
    if (!access)
        throw new AppError(ErrorCode.NOT_FOUND, "Folder not found", 404);
    return access;
}

async function configurationDto(
    target: ExportTarget,
    viewerId: string,
    organization: boolean,
    canManage?: boolean,
): Promise<FolderExportConfigurationDto> {
    const dto = toConfigurationDto(target);
    if (!organization) return dto;
    const manages = canManage ?? (await mayWriteOrganizationExport(viewerId));
    return {
        ...dto,
        // The role-loss failure is stored as a code; stoppedReason carries it.
        lastError:
            manages && dto.lastError !== WRITER_NO_LONGER_CURATOR
                ? dto.lastError
                : null,
        writer: { id: target.userId, name: target.writerName ?? target.userId },
        canEdit: manages && target.userId === viewerId,
        canRemove: manages,
        stoppedReason:
            manages && !(await mayWriteOrganizationExport(target.userId))
                ? WRITER_NO_LONGER_CURATOR
                : null,
    };
}

export async function listFolderExports(
    userId: string,
    folderId: string,
): Promise<{
    configured: FolderExportConfigurationDto[];
    applicableIds: string[];
    /** Applicable exports the caller writes, the ones a synchronization audits. */
    synchronizableIds: string[];
}> {
    assertFolderExportsAvailable();
    const access = await requireExportFolder(userId, folderId);
    const folders = await db
        .select({
            id: recordingFolders.id,
            parentId: recordingFolders.parentId,
        })
        .from(recordingFolders)
        .where(eq(recordingFolders.userId, access.ownerId));
    const organization = access.scope === "org";
    const targets = organization
        ? await listOrganizationExportTargets(userId, folderId)
        : await listExportTargets(userId);
    const manages = organization && (await mayWriteOrganizationExport(userId));
    const applicableIds = applicableExportConfigurationIds(
        folders,
        folderId,
        targets,
    );
    const ownIds = new Set(
        targets
            .filter((target) => target.userId === userId)
            .map((target) => target.id),
    );
    return {
        configured: await Promise.all(
            targets
                .filter((target) => target.folderId === folderId)
                .map((target) =>
                    configurationDto(target, userId, organization, manages),
                ),
        ),
        applicableIds,
        synchronizableIds: applicableIds.filter((id) => ownIds.has(id)),
    };
}

export async function createFolderExport(
    userId: string,
    folderId: string,
    input: SaveFolderExportInput,
): Promise<FolderExportConfigurationDto> {
    const provider = providerOf(input);
    assertProviderAvailable(provider);
    const exportMail = input.exportMail ?? false;
    validateSelection({ ...input, exportMail });
    await assertExportableFolder(userId, folderId);
    const targetPath =
        input.provider === "google-drive"
            ? null
            : filesystemTargetPath(input.targetPath);
    const drive =
        input.provider === "google-drive"
            ? await inspectDriveFolder(userId, input.rootFolderId)
            : null;
    const configuration = await db.transaction(async (tx) => {
        const [created] = await tx
            .insert(folderExportConfigurations)
            .values({
                userId,
                folderId,
                provider,
                exportAudio: input.exportAudio,
                exportTranscript: input.exportTranscript,
                exportSummary: input.exportSummary,
                exportMail,
            })
            .returning();
        if (!created) throw new Error("Export configuration was not created");
        if (targetPath !== null) {
            await tx.insert(filesystemExportSettings).values({
                exportConfigurationId: created.id,
                userId,
                targetPath,
            });
        }
        if (drive && input.provider === "google-drive") {
            await tx.insert(googleDriveExportSettings).values({
                exportConfigurationId: created.id,
                userId,
                accountSubject: drive.accountSubject,
                rootFolderId: drive.id,
                rootFolderName: drive.name,
                driveId: drive.driveId,
                transcriptFormat: input.transcriptFormat,
                summaryFormat: input.summaryFormat,
            });
        }
        return created;
    });
    await enqueueExportPlan(userId, configuration.id);
    return savedDto(userId, configuration.id);
}

export async function updateFolderExport(
    userId: string,
    folderId: string,
    exportId: string,
    input: SaveFolderExportInput,
): Promise<FolderExportConfigurationDto> {
    const provider = providerOf(input);
    assertProviderAvailable(provider);
    const access = await requireExportFolder(userId, folderId);
    if (access.scope === "org") await assertExportableFolder(userId, folderId);
    const existing = await loadExportTarget(userId, exportId);
    if (!existing || existing.folderId !== folderId) {
        throw new AppError(ErrorCode.NOT_FOUND, "Export not found", 404);
    }
    const exportMail = input.exportMail ?? existing.exportMail;
    validateSelection({ ...input, exportMail });
    if (existing.provider !== provider) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "The provider of an export cannot change",
            400,
        );
    }
    const targetPath =
        input.provider === "google-drive"
            ? null
            : filesystemTargetPath(input.targetPath);
    const drive =
        input.provider === "google-drive"
            ? await inspectDriveFolder(userId, input.rootFolderId)
            : null;
    await db.transaction(async (tx) => {
        const [updated] = await tx
            .update(folderExportConfigurations)
            .set({
                exportAudio: input.exportAudio,
                exportTranscript: input.exportTranscript,
                exportSummary: input.exportSummary,
                exportMail,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(folderExportConfigurations.id, exportId),
                    eq(folderExportConfigurations.userId, userId),
                    eq(folderExportConfigurations.folderId, folderId),
                ),
            )
            .returning();
        if (!updated) {
            throw new AppError(ErrorCode.NOT_FOUND, "Export not found", 404);
        }
        if (targetPath !== null) {
            await tx
                .update(filesystemExportSettings)
                .set({ targetPath, updatedAt: new Date() })
                .where(
                    and(
                        eq(
                            filesystemExportSettings.exportConfigurationId,
                            exportId,
                        ),
                        eq(filesystemExportSettings.userId, userId),
                    ),
                );
        }
        if (drive && input.provider === "google-drive") {
            await tx
                .update(googleDriveExportSettings)
                .set({
                    accountSubject: drive.accountSubject,
                    rootFolderId: drive.id,
                    rootFolderName: drive.name,
                    driveId: drive.driveId,
                    transcriptFormat: input.transcriptFormat,
                    summaryFormat: input.summaryFormat,
                    updatedAt: new Date(),
                })
                .where(
                    and(
                        eq(
                            googleDriveExportSettings.exportConfigurationId,
                            exportId,
                        ),
                        eq(googleDriveExportSettings.userId, userId),
                    ),
                );
        }
    });
    await enqueueExportPlan(userId, exportId);
    return savedDto(userId, exportId);
}

async function savedDto(
    userId: string,
    exportId: string,
): Promise<FolderExportConfigurationDto> {
    const target = await loadExportTarget(userId, exportId);
    if (!target) throw new Error("Saved export configuration disappeared");
    const access = await requireExportFolder(userId, target.folderId);
    return configurationDto(target, userId, access.scope === "org");
}

export async function deleteFolderExport(
    userId: string,
    folderId: string,
    exportId: string,
): Promise<void> {
    assertFolderExportsAvailable();
    const access = await requireExportFolder(userId, folderId);
    if (access.scope === "org") await assertExportableFolder(userId, folderId);
    const deleted = await db
        .delete(folderExportConfigurations)
        .where(
            and(
                eq(folderExportConfigurations.id, exportId),
                access.scope === "org"
                    ? inArray(
                          folderExportConfigurations.folderId,
                          db
                              .select({ id: recordingFolders.id })
                              .from(recordingFolders)
                              .where(
                                  eq(recordingFolders.userId, access.ownerId),
                              ),
                      )
                    : eq(folderExportConfigurations.userId, userId),
                eq(folderExportConfigurations.folderId, folderId),
            ),
        )
        .returning({ id: folderExportConfigurations.id });
    if (deleted.length === 0) {
        throw new AppError(ErrorCode.NOT_FOUND, "Export not found", 404);
    }
}
