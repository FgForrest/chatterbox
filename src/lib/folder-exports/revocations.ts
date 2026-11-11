import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { folderExportMaterializations } from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    GoogleApiError,
    GoogleConnectionUnavailableError,
} from "@/lib/integrations/google/errors";
import { DriveTargetLostError } from "./drive-provider";
import { withExportLocks } from "./lock";
import { createExportProvider } from "./provider-factory";
import { isExportErrorRetryable } from "./retry";
import { loadExportTarget } from "./target";

type Configuration = { id: string; userId: string };

function revocationError(error: unknown, constructing = false) {
    if (
        error instanceof AppError &&
        error.code === ErrorCode.EXPORT_REVOCATION_BLOCKED
    )
        return error;
    if (
        isExportErrorRetryable(error) &&
        !(
            constructing &&
            !(error instanceof GoogleApiError) &&
            !(error instanceof AppError)
        )
    )
        return exportRevocationPending();
    const cause =
        error instanceof GoogleConnectionUnavailableError
            ? error.problem
            : error instanceof DriveTargetLostError
              ? "target_lost"
              : constructing
                ? "provider_unavailable"
                : "removal_refused";
    const message =
        error instanceof GoogleConnectionUnavailableError
            ? error.message
            : error instanceof DriveTargetLostError
              ? "The export target is unavailable. Pick an accessible target."
              : constructing
                ? "The export provider could not be initialized. Check its configuration."
                : "The export provider refused removal. Check its permissions and target.";
    return new AppError(ErrorCode.EXPORT_REVOCATION_BLOCKED, message, 409, {
        retryable: false,
        cause,
    });
}

/** A cleanup obligation remains durable and the operation can be retried. */
export function exportRevocationPending() {
    return new AppError(
        ErrorCode.EXPORT_REVOCATION_PENDING,
        "Restricted export copies still need to be removed. Try again.",
        409,
        { retryable: true },
    );
}

/** Refuse a cascade that would discard a newly marked revocation under the tree lock. */
export async function assertNoPendingExportRevocations(
    executor: Pick<typeof db, "select">,
    configurations: Configuration[],
) {
    for (const configuration of configurations) {
        const [pending] = await executor
            .select({ id: folderExportMaterializations.id })
            .from(folderExportMaterializations)
            .where(
                and(
                    eq(
                        folderExportMaterializations.exportConfigurationId,
                        configuration.id,
                    ),
                    eq(
                        folderExportMaterializations.userId,
                        configuration.userId,
                    ),
                    eq(folderExportMaterializations.revocationPending, true),
                ),
            )
            .limit(1);
        if (pending) throw exportRevocationPending();
    }
}

async function cleanPendingRevocations(configuration: Configuration) {
    const pending = await db
        .select()
        .from(folderExportMaterializations)
        .where(
            and(
                eq(
                    folderExportMaterializations.exportConfigurationId,
                    configuration.id,
                ),
                eq(folderExportMaterializations.userId, configuration.userId),
                eq(folderExportMaterializations.revocationPending, true),
            ),
        );
    if (!pending.length) return;
    try {
        const target = await loadExportTarget(
            configuration.userId,
            configuration.id,
        );
        if (!target)
            throw new AppError(
                ErrorCode.EXPORT_REVOCATION_BLOCKED,
                "The export target configuration is missing. Choose a target before retrying removal.",
                409,
                { retryable: false, cause: "target_missing" },
            );
        const provider = await createExportProvider(target).catch(
            (error: unknown) => {
                throw revocationError(error, true);
            },
        );
        const failures: unknown[] = [];
        const completed: string[] = [];
        const unconfirmed: typeof pending = [];
        for (const state of pending) {
            try {
                const removed = await provider.removeFile(state.logicalPath, {
                    duplicate: false,
                    revoked: true,
                });
                if (removed) completed.push(state.id);
                else unconfirmed.push(state);
            } catch (error) {
                failures.push(error);
            }
        }
        if (unconfirmed.length) {
            const owned = await provider.ownedEntries();
            completed.push(
                ...unconfirmed
                    .filter((state) => !owned.has(state.logicalPath))
                    .map((state) => state.id),
            );
        }
        if (completed.length)
            await db
                .delete(folderExportMaterializations)
                .where(
                    and(
                        eq(
                            folderExportMaterializations.exportConfigurationId,
                            configuration.id,
                        ),
                        eq(
                            folderExportMaterializations.userId,
                            configuration.userId,
                        ),
                        eq(
                            folderExportMaterializations.revocationPending,
                            true,
                        ),
                        inArray(folderExportMaterializations.id, completed),
                    ),
                );
        const permanent = failures.find(
            (error) => !isExportErrorRetryable(error),
        );
        if (permanent !== undefined) throw revocationError(permanent);
        if (failures.length) throw exportRevocationPending();
        await assertNoPendingExportRevocations(db, [configuration]);
    } catch (error) {
        throw revocationError(error);
    }
}

/** Clean only restricted revocations outside transactions, holding export locks through the final cascade. */
export async function withExportRevocationCleanup<T>(
    configurations: Configuration[],
    work: () => Promise<T>,
): Promise<T> {
    return withExportLocks(
        configurations.map((entry) => entry.id),
        async () => {
            for (const configuration of configurations)
                await cleanPendingRevocations(configuration);
            return work();
        },
    );
}
