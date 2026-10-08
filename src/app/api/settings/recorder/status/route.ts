import { and, desc, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import {
    getRecorderServerConfig,
    serializeRecorderServerConfig,
} from "@/lib/recorder/config";

/**
 * `GET /api/settings/recorder/status` — the user's active recorder keys plus
 * the server's recorder defaults, for the Settings -> Meeting Recorder card.
 */
export const GET = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);

    const rows = await db
        .select({
            id: apiKeys.id,
            name: apiKeys.name,
            keyPrefix: apiKeys.keyPrefix,
            createdAt: apiKeys.createdAt,
            lastUsedAt: apiKeys.lastUsedAt,
        })
        .from(apiKeys)
        .where(
            and(
                eq(apiKeys.userId, session.user.id),
                eq(apiKeys.source, "recorder"),
                isNull(apiKeys.revokedAt),
            ),
        )
        .orderBy(desc(apiKeys.createdAt));

    return NextResponse.json({
        keys: rows.map((row) => ({
            id: row.id,
            name: row.name,
            key_prefix: row.keyPrefix,
            created_at: row.createdAt,
            last_used_at: row.lastUsedAt,
        })),
        ...serializeRecorderServerConfig(getRecorderServerConfig()),
    });
});
