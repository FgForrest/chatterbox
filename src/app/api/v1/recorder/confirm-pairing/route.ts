import { and, eq, isNull, lt, ne } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { gateRecordingSessionRequest } from "@/lib/recording-sessions/route-gate";

/** Revoke only older keys minted for this user's confirmed installation. */
export const POST = apiHandler(async (request: Request) => {
    const gate = await gateRecordingSessionRequest(request);
    if (gate.response) return gate.response;
    const body = (await request.json().catch(() => null)) as Record<
        string,
        unknown
    > | null;
    const installationId = body?.installationId;
    if (typeof installationId !== "string") {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Installation ID is required",
            400,
        );
    }
    const [current] = await db
        .select({ id: apiKeys.id, createdAt: apiKeys.createdAt })
        .from(apiKeys)
        .where(
            and(
                eq(apiKeys.id, gate.authn.apiKeyId),
                eq(apiKeys.userId, gate.authn.user.id),
                eq(apiKeys.source, "recorder"),
                eq(apiKeys.installationId, installationId),
            ),
        )
        .limit(1);
    if (!current) {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Installation does not match this recorder key",
            403,
        );
    }
    await db
        .update(apiKeys)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(
            and(
                eq(apiKeys.userId, gate.authn.user.id),
                eq(apiKeys.source, "recorder"),
                eq(apiKeys.installationId, installationId),
                ne(apiKeys.id, current.id),
                lt(apiKeys.createdAt, current.createdAt),
                isNull(apiKeys.revokedAt),
            ),
        );
    return NextResponse.json({ success: true });
});
