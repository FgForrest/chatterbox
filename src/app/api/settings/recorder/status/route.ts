import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { apiKeys, recordingCaptureKeys } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import { assertNotOrgAccount } from "@/lib/org/config";
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
    await assertNotOrgAccount(session.user.id);

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

    const captures = await db
        .select({
            clientRecordingId: recordingCaptureKeys.clientRecordingId,
            apiKeyId: recordingCaptureKeys.apiKeyId,
            expiresAt: recordingCaptureKeys.expiresAt,
            createdAt: recordingCaptureKeys.createdAt,
        })
        .from(recordingCaptureKeys)
        .where(
            and(
                eq(recordingCaptureKeys.userId, session.user.id),
                eq(recordingCaptureKeys.status, "active"),
                gt(recordingCaptureKeys.expiresAt, new Date()),
            ),
        )
        .orderBy(desc(recordingCaptureKeys.createdAt));

    return NextResponse.json({
        keys: rows.map((row) => ({
            id: row.id,
            name: row.name,
            key_prefix: row.keyPrefix,
            created_at: row.createdAt,
            last_used_at: row.lastUsedAt,
        })),
        pending_captures: captures.map((capture) => ({
            client_recording_id: capture.clientRecordingId,
            api_key_id: capture.apiKeyId,
            created_at: capture.createdAt,
            expires_at: capture.expiresAt,
        })),
        ...serializeRecorderServerConfig(getRecorderServerConfig()),
    });
});
