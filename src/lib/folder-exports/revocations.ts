import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { folderExportMaterializations } from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { withExportLocks } from "./lock";
import { createExportProvider } from "./provider-factory";
import { loadExportTarget } from "./target";

type Configuration = { id: string; userId: string };

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
        if (!target) throw exportRevocationPending();
        const provider = await createExportProvider(target);
        const completed: string[] = [];
        for (const state of pending) {
            try {
                const removed = await provider.removeFile(state.logicalPath, {
                    duplicate: false,
                    revoked: true,
                });
                if (
                    removed ||
                    !(await provider.ownedEntries()).has(state.logicalPath)
                )
                    completed.push(state.id);
            } catch {
                // Keep the ledger and provider node until a later removal confirms absence.
            }
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
        await assertNoPendingExportRevocations(db, [configuration]);
    } catch {
        throw exportRevocationPending();
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
