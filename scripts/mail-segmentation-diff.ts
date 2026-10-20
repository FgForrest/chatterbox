import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { db, sqlClient } from "@/db";
import { mailContents, mailMessages, users } from "@/db/schema";
import type { ContentSegment } from "@/lib/content/types";
import { decryptJsonField } from "@/lib/encryption/fields";
import { knownQuotedItems, markKnownQuotes } from "@/lib/mail/known-quotes";
import { knownSignaturesFor } from "@/lib/mail/known-signatures";
import { parseMessage } from "@/lib/mail/parse";
import { readRawMail } from "@/lib/mail/raw-storage";
import { segmentMail } from "@/lib/mail/segment";
import { mailSegmentationDiff } from "@/lib/mail/segmentation-diff";
import { createUserStorageProvider } from "@/lib/storage/factory";

/** Compares stored mail with current segmentation without writing; samples go only to stdout. */
export async function runMailSegmentationDiff(args: string[]) {
    const { values } = parseArgs({
        args,
        options: {
            user: { type: "string" },
            samples: { type: "string", default: "0" },
        },
        strict: true,
        allowPositionals: false,
    });
    const sampleLimit = Number(values.samples);
    if (!Number.isSafeInteger(sampleLimit) || sampleLimit < 0)
        throw new Error("--samples must be a non-negative integer");
    if (values.user !== undefined && !values.user.trim())
        throw new Error("--user must be a non-empty id");
    const counts = {
        checked: 0,
        unchanged: 0,
        changed: 0,
        skippedRawReaped: 0,
        newSignatureByCue: {
            markup: 0,
            delimiter: 0,
            closing: 0,
            known: 0,
            contact: 0,
            footer: 0,
        },
        bodyShrank: 0,
        bodyEmptied: 0,
        quotedPartChanged: 0,
    };
    let sampled = 0;
    let ownerCursor: string | undefined;
    while (true) {
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
        if (owners.length === 0) break;
        for (const owner of owners) {
            let cursor: string | undefined;
            const storage = await createUserStorageProvider(owner.id);
            while (true) {
                const rows = await db
                    .select({
                        id: mailMessages.id,
                        rawStoragePath: mailMessages.rawStoragePath,
                        receivedAt: mailMessages.receivedAt,
                        senderVerified: mailMessages.senderVerified,
                        segments: mailContents.segments,
                    })
                    .from(mailMessages)
                    .leftJoin(
                        mailContents,
                        and(
                            eq(mailContents.itemId, mailMessages.id),
                            eq(mailContents.userId, owner.id),
                        ),
                    )
                    .where(
                        and(
                            eq(mailMessages.userId, owner.id),
                            isNull(mailMessages.deletedAt),
                            cursor ? gt(mailMessages.id, cursor) : undefined,
                        ),
                    )
                    .orderBy(asc(mailMessages.id))
                    .limit(100);
                if (rows.length === 0) break;
                for (const row of rows) {
                    if (
                        !row.rawStoragePath ||
                        !(await storage.exists(row.rawStoragePath))
                    ) {
                        counts.skippedRawReaped++;
                        continue;
                    }
                    const parsed = await parseMessage(
                        await readRawMail(owner.id, row.rawStoragePath),
                    );
                    const [knownSignatures, knownQuotes] = await Promise.all([
                        knownSignaturesFor(
                            owner.id,
                            parsed.from[0]?.address ?? null,
                            row,
                        ),
                        knownQuotedItems(
                            owner.id,
                            parsed.references,
                            parsed.inReplyTo,
                        ),
                    ]);
                    const after = markKnownQuotes(
                        segmentMail({
                            ...parsed,
                            from: parsed.from[0] ?? null,
                            fromAuthenticated: row.senderVerified,
                            knownSignatures,
                        }).segments,
                        knownQuotes,
                    );
                    const before =
                        decryptJsonField<ContentSegment[]>(row.segments) ?? [];
                    const diff = mailSegmentationDiff(before, after);
                    counts.checked++;
                    if (!diff.changed) {
                        counts.unchanged++;
                        continue;
                    }
                    counts.changed++;
                    for (const cue of diff.newSignatures)
                        if (cue) counts.newSignatureByCue[cue]++;
                    if (diff.bodyShrank) counts.bodyShrank++;
                    if (diff.bodyEmptied) counts.bodyEmptied++;
                    if (diff.quotedPartChanged) counts.quotedPartChanged++;
                    if (sampled < sampleLimit) {
                        console.log(
                            JSON.stringify({ itemId: row.id, before, after }),
                        );
                        sampled++;
                    }
                }
                cursor = rows.at(-1)?.id;
            }
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
    runMailSegmentationDiff(process.argv.slice(2))
        .catch((err) => {
            console.error("mail-segmentation-diff failed:", err);
            process.exitCode = 1;
        })
        .finally(async () => {
            await sqlClient?.end();
        });
}
