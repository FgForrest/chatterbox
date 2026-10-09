import { NextResponse } from "next/server";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { createApiKey, getApiKeyPrefix, hashApiKey } from "@/lib/auth-request";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { captureServerEvent } from "@/lib/posthog-server";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
import {
    getRecorderServerConfig,
    serializeRecorderServerConfig,
} from "@/lib/recorder/config";

const PAIR_LIMIT_PER_HOUR = 10;

/**
 * `POST /api/settings/recorder/pair` — mint a recorder key for the extension.
 *
 * Called by the Settings -> Meeting Recorder button once it has detected an
 * extension to hand the key to. The key carries only `recordings:write`, is
 * returned exactly once, and is labelled so it can be listed and revoked as
 * a recorder key rather than a generic API key.
 */
export const POST = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);

    const limit = await consumeRateLimitBucket(
        `recorder:pair:user:${session.user.id}`,
        { limit: PAIR_LIMIT_PER_HOUR, windowMs: 60 * 60 * 1000 },
    );
    if (!limit.allowed) {
        throw new AppError(
            ErrorCode.RATE_LIMITED,
            "Too many recorder keys created recently. Try again later.",
            429,
        );
    }

    const body = (await request.json().catch(() => ({}))) as {
        label?: unknown;
    };
    const label =
        typeof body.label === "string" && body.label.trim() !== ""
            ? body.label.trim().slice(0, 80)
            : new Date().toISOString().slice(0, 10);

    const rawKey = createApiKey();
    const [apiKey] = await db
        .insert(apiKeys)
        .values({
            userId: session.user.id,
            name: `Meeting Recorder (${label})`,
            keyHash: hashApiKey(rawKey),
            keyPrefix: getApiKeyPrefix(rawKey),
            source: "recorder",
            scopes: ["recordings:write"],
        })
        .returning({ id: apiKeys.id });

    await captureServerEvent({
        distinctId: session.user.id,
        event: "recorder_paired",
    });

    const config = getRecorderServerConfig();
    return NextResponse.json(
        {
            key_id: apiKey.id,
            api_key: rawKey,
            ...serializeRecorderServerConfig(config),
        },
        { status: 201 },
    );
});
