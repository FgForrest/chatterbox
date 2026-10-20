import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { and, asc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, sqlClient } from "@/db";
import {
    learnReviewItems,
    learnRuns,
    mailParticipants,
    people,
    personEmails,
    users,
} from "@/db/schema";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import { isInternalMailAddress } from "@/lib/mail/internal-address";

/** Unlinks inbound routing addresses per user; defaults to counting without writing. */
export async function runUnlinkInternalAddresses(args: string[]) {
    const { values } = parseArgs({
        args,
        options: {
            user: { type: "string" },
            apply: { type: "boolean", default: false },
        },
        strict: true,
        allowPositionals: false,
    });
    if (values.user !== undefined && !values.user.trim())
        throw new Error("--user must be a non-empty id");
    const counts = {
        participants: 0,
        primaryEmails: 0,
        additionalEmails: 0,
        proposals: 0,
    };
    const internal = (email: string | null) =>
        Boolean(email && isInternalMailAddress(decryptText(email)));
    let ownerCursor: string | undefined;
    while (env.MAIL_DOMAIN) {
        const owners = await db
            .select({ id: users.id })
            .from(users)
            .where(
                and(
                    values.user ? eq(users.id, values.user) : undefined,
                    ownerCursor ? gt(users.id, ownerCursor) : undefined,
                ),
            )
            .orderBy(asc(users.id))
            .limit(100);
        if (!owners.length) break;
        for (const owner of owners) {
            const affected = await db.transaction(async (tx) => {
                const runs = await tx
                    .select({
                        id: learnRuns.id,
                        itemId: learnRuns.itemId,
                        userId: learnRuns.userId,
                    })
                    .from(learnRuns)
                    .where(
                        and(
                            eq(learnRuns.scopeUserId, owner.id),
                            eq(learnRuns.status, "ready"),
                            isNull(learnRuns.transcriptionId),
                        ),
                    )
                    .orderBy(asc(learnRuns.id))
                    .for("update");
                const proposals: string[] = [];
                for (const run of runs) {
                    const participants = await tx
                        .select({
                            ref: mailParticipants.ref,
                            address: mailParticipants.address,
                        })
                        .from(mailParticipants)
                        .where(
                            and(
                                eq(mailParticipants.userId, run.userId),
                                eq(mailParticipants.itemId, run.itemId),
                            ),
                        );
                    const internalRefs = new Set(
                        participants
                            .filter((row) => internal(row.address))
                            .map((row) => row.ref),
                    );
                    const items = await tx
                        .select({
                            id: learnReviewItems.id,
                            payload: learnReviewItems.payload,
                        })
                        .from(learnReviewItems)
                        .where(
                            and(
                                eq(learnReviewItems.userId, owner.id),
                                eq(learnReviewItems.runId, run.id),
                                eq(learnReviewItems.kind, "new_record"),
                                isNull(learnReviewItems.decision),
                                isNull(learnReviewItems.outcome),
                            ),
                        )
                        .for("update");
                    for (const item of items) {
                        const payload = decryptJsonField<
                            Record<string, unknown>
                        >(item.payload);
                        if (payload?.kind !== "person") continue;
                        if (
                            (typeof payload.address === "string" &&
                                isInternalMailAddress(payload.address)) ||
                            (typeof payload.speakerLabel === "string" &&
                                internalRefs.has(payload.speakerLabel))
                        )
                            proposals.push(item.id);
                    }
                }
                const participants = (
                    await tx
                        .select({
                            id: mailParticipants.id,
                            address: mailParticipants.address,
                        })
                        .from(mailParticipants)
                        .where(
                            and(
                                eq(mailParticipants.userId, owner.id),
                                isNotNull(mailParticipants.personId),
                            ),
                        )
                        .for("update")
                ).filter((row) => internal(row.address));
                const primary = (
                    await tx
                        .select({ id: people.id, email: people.primaryEmail })
                        .from(people)
                        .where(
                            and(
                                eq(people.userId, owner.id),
                                isNotNull(people.primaryEmail),
                            ),
                        )
                        .for("update")
                ).filter((row) => internal(row.email));
                const additional = (
                    await tx
                        .select({
                            hash: personEmails.emailHash,
                            email: personEmails.email,
                        })
                        .from(personEmails)
                        .where(eq(personEmails.userId, owner.id))
                        .for("update")
                ).filter((row) => internal(row.email));
                if (values.apply) {
                    for (const row of participants)
                        await tx
                            .update(mailParticipants)
                            .set({ personId: null })
                            .where(
                                and(
                                    eq(mailParticipants.userId, owner.id),
                                    eq(mailParticipants.id, row.id),
                                ),
                            );
                    for (const row of primary)
                        await tx
                            .update(people)
                            .set({ primaryEmail: null, primaryEmailHash: null })
                            .where(
                                and(
                                    eq(people.userId, owner.id),
                                    eq(people.id, row.id),
                                ),
                            );
                    for (const row of additional)
                        await tx
                            .delete(personEmails)
                            .where(
                                and(
                                    eq(personEmails.userId, owner.id),
                                    eq(personEmails.emailHash, row.hash),
                                ),
                            );
                    if (proposals.length)
                        await tx
                            .delete(learnReviewItems)
                            .where(
                                and(
                                    eq(learnReviewItems.userId, owner.id),
                                    inArray(learnReviewItems.id, proposals),
                                    isNull(learnReviewItems.decision),
                                    isNull(learnReviewItems.outcome),
                                ),
                            );
                }
                return {
                    participants: participants.length,
                    primaryEmails: primary.length,
                    additionalEmails: additional.length,
                    proposals: proposals.length,
                };
            });
            counts.participants += affected.participants;
            counts.primaryEmails += affected.primaryEmails;
            counts.additionalEmails += affected.additionalEmails;
            counts.proposals += affected.proposals;
        }
        ownerCursor = owners.at(-1)?.id;
    }
    console.log(JSON.stringify(counts, null, 2));
    return counts;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    runUnlinkInternalAddresses(process.argv.slice(2))
        .catch(() => {
            console.error("unlink-internal-addresses failed");
            process.exitCode = 1;
        })
        .finally(async () => {
            await sqlClient?.end();
        });
}
