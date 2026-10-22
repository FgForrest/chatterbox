import { and, eq, or } from "drizzle-orm";
import { db } from "@/db";
import { processingProfileRevisions, processingProfiles } from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    lockPipelineTargetsInTx,
    type PipelineJobTarget,
} from "./pipeline-jobs";
import { lockProfileMutation } from "./profile-mutations";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Serialize a new run reference with deletion of its already-authorized profile. */
export async function lockProfileRevisionInTx(
    tx: Transaction,
    ownerUserId: string,
    revisionId: string,
): Promise<void> {
    await lockProfileMutation(tx, ownerUserId);
    const [revision] = await tx
        .select({ id: processingProfileRevisions.id })
        .from(processingProfileRevisions)
        .innerJoin(
            processingProfiles,
            eq(processingProfiles.id, processingProfileRevisions.profileId),
        )
        .where(
            and(
                eq(processingProfiles.ownerUserId, ownerUserId),
                eq(processingProfileRevisions.id, revisionId),
            ),
        )
        .limit(1);
    if (!revision)
        throw new AppError(
            ErrorCode.CONFLICT,
            "The selected processing profile revision is unavailable",
            409,
        );
}

/** Keep an authorized revision available until its queued history reference commits. */
export async function withProfileRevisionGuard<T>(
    input: {
        revisionId: string;
        actorUserId: string;
        organizationUserId: string | null;
        pipelineTarget?: Pick<PipelineJobTarget, "itemId" | "userId">;
    },
    queue: (
        tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    ) => Promise<T>,
): Promise<T> {
    return db.transaction(async (tx) => {
        if (input.pipelineTarget)
            await lockPipelineTargetsInTx(tx, [input.pipelineTarget], true);
        async function findOwner() {
            const [profile] = await tx
                .select({ ownerUserId: processingProfiles.ownerUserId })
                .from(processingProfiles)
                .innerJoin(
                    processingProfileRevisions,
                    eq(
                        processingProfileRevisions.profileId,
                        processingProfiles.id,
                    ),
                )
                .where(
                    and(
                        eq(processingProfileRevisions.id, input.revisionId),
                        or(
                            and(
                                eq(
                                    processingProfiles.ownerUserId,
                                    input.actorUserId,
                                ),
                                eq(processingProfiles.scope, "personal"),
                            ),
                            input.organizationUserId
                                ? and(
                                      eq(
                                          processingProfiles.ownerUserId,
                                          input.organizationUserId,
                                      ),
                                      eq(
                                          processingProfiles.scope,
                                          "organization",
                                      ),
                                  )
                                : undefined,
                        ),
                    ),
                )
                .limit(1);
            if (!profile)
                throw new AppError(
                    ErrorCode.CONFLICT,
                    "The selected processing profile revision is unavailable",
                    409,
                );
            return profile.ownerUserId;
        }
        const ownerUserId = await findOwner();
        await lockProfileRevisionInTx(tx, ownerUserId, input.revisionId);
        return queue(tx);
    });
}
