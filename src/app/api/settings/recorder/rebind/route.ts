import { and, eq, gt, isNull, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { apiKeys, recordingCaptureKeys, recordingSessions } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { assertNotOrgAccount } from "@/lib/org/config";

/** Let the signed-in capture owner bind unfinished ciphertext to a new recorder key. */
export const POST = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    await assertNotOrgAccount(session.user.id, {
        surface: "settings/recorder/rebind",
    });
    const body = (await request.json().catch(() => null)) as Record<
        string,
        unknown
    > | null;
    const clientRecordingId = body?.clientRecordingId;
    const apiKeyId = body?.apiKeyId;
    if (typeof clientRecordingId !== "string" || typeof apiKeyId !== "string") {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Capture and recorder key are required",
            400,
        );
    }
    await db.transaction(async (tx) => {
        const [key] = await tx
            .select({ id: apiKeys.id, scopes: apiKeys.scopes })
            .from(apiKeys)
            .where(
                and(
                    eq(apiKeys.id, apiKeyId),
                    eq(apiKeys.userId, session.user.id),
                    eq(apiKeys.source, "recorder"),
                    isNull(apiKeys.revokedAt),
                    or(
                        isNull(apiKeys.expiresAt),
                        gt(apiKeys.expiresAt, new Date()),
                    ),
                ),
            )
            .limit(1);
        if (!key?.scopes.includes("recordings:write")) {
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Recorder key not found",
                404,
            );
        }
        const [capture] = await tx
            .select()
            .from(recordingCaptureKeys)
            .where(
                and(
                    eq(recordingCaptureKeys.userId, session.user.id),
                    eq(
                        recordingCaptureKeys.clientRecordingId,
                        clientRecordingId,
                    ),
                    eq(recordingCaptureKeys.status, "active"),
                    gt(recordingCaptureKeys.expiresAt, new Date()),
                ),
            )
            .for("update")
            .limit(1);
        if (!capture?.encryptedKey || !capture.activeSessionId) {
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Recoverable capture not found",
                404,
            );
        }
        const [active] = await tx
            .select({ status: recordingSessions.status })
            .from(recordingSessions)
            .where(
                and(
                    eq(recordingSessions.id, capture.activeSessionId),
                    eq(recordingSessions.userId, session.user.id),
                    eq(recordingSessions.captureKeyId, capture.id),
                ),
            )
            .limit(1);
        if (
            !active ||
            active.status === "completing" ||
            active.status === "completed"
        ) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "Capture is already finalizing or complete",
                409,
            );
        }
        await tx
            .update(recordingCaptureKeys)
            .set({ apiKeyId, updatedAt: new Date() })
            .where(
                and(
                    eq(recordingCaptureKeys.id, capture.id),
                    eq(recordingCaptureKeys.userId, session.user.id),
                ),
            );
        await tx
            .update(recordingSessions)
            .set({ apiKeyId, updatedAt: new Date() })
            .where(
                and(
                    eq(recordingSessions.id, capture.activeSessionId),
                    eq(recordingSessions.userId, session.user.id),
                ),
            );
    });
    return NextResponse.json({ success: true });
});
