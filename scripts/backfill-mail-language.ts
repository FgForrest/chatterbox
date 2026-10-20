import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { db, sqlClient } from "@/db";
import { mailContents, users } from "@/db/schema";
import type { ContentSegment } from "@/lib/content/types";
import { decryptJsonField } from "@/lib/encryption/fields";
import { detectMailLanguage } from "@/lib/mail/language";

/** Backfills null mail languages in batches, printing counts without exposing mail content. */
export async function runBackfillMailLanguage(args: string[]) {
    const { values } = parseArgs({
        args,
        options: {
            user: { type: "string" },
            "dry-run": { type: "boolean", default: false },
        },
        strict: true,
        allowPositionals: false,
    });
    if (values.user !== undefined && !values.user.trim())
        throw new Error("--user must be a non-empty id");
    const counts = {
        checked: 0,
        updated: 0,
        languages: {} as Record<string, number>,
    };
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
        if (!owners.length) break;
        for (const owner of owners) {
            let cursor: string | undefined;
            while (true) {
                const rows = await db
                    .select({
                        id: mailContents.id,
                        segments: mailContents.segments,
                    })
                    .from(mailContents)
                    .where(
                        and(
                            eq(mailContents.userId, owner.id),
                            isNull(mailContents.language),
                            cursor ? gt(mailContents.id, cursor) : undefined,
                        ),
                    )
                    .orderBy(asc(mailContents.id))
                    .limit(100);
                if (!rows.length) break;
                for (const row of rows) {
                    const language = detectMailLanguage(
                        decryptJsonField<ContentSegment[]>(row.segments) ?? [],
                    );
                    counts.checked++;
                    const key = language ?? "null";
                    counts.languages[key] = (counts.languages[key] ?? 0) + 1;
                    if (!language || values["dry-run"]) continue;
                    const updated = await db
                        .update(mailContents)
                        .set({ language })
                        .where(
                            and(
                                eq(mailContents.id, row.id),
                                eq(mailContents.userId, owner.id),
                                isNull(mailContents.language),
                                eq(mailContents.segments, row.segments),
                            ),
                        )
                        .returning({ id: mailContents.id });
                    counts.updated += updated.length;
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
    runBackfillMailLanguage(process.argv.slice(2))
        .catch((err) => {
            console.error("backfill-mail-language failed:", err);
            process.exitCode = 1;
        })
        .finally(async () => {
            await sqlClient?.end();
        });
}
