import { NextResponse } from "next/server";
import { z } from "zod";
import { queryRoomRecorders } from "@/db/queries/recorder-rooms";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { recorderRoomKeyFor } from "@/lib/meetings/room-key";
import {
    assertRateLimitAllowed,
    consumeRateLimitBucket,
    getClientIp,
} from "@/lib/rate-limit";
import { requireRecorderRooms } from "@/lib/recording-sessions/lease-route";
import { gateRecordingSessionRequest } from "@/lib/recording-sessions/route-gate";

const roomBody = z.strictObject({ room: z.string() });
const WINDOW_MS = 60_000;

/**
 * `POST /api/v1/recorder/rooms/recorders`: names the other active members
 * holding a live capture lease in one room, with the earliest lease expiry.
 * 404 outside self-host
 * Organization mode; rate limited per account and per IP.
 */
export const POST = apiHandler(async (request: Request) => {
    requireRecorderRooms();
    const gate = await gateRecordingSessionRequest(request);
    if (gate.response) return gate.response;
    const userId = gate.authn.user.id;
    const limits = await Promise.all([
        consumeRateLimitBucket(`recorder-rooms:user:${userId}`, {
            limit: 48,
            windowMs: WINDOW_MS,
        }),
        consumeRateLimitBucket(`recorder-rooms:ip:${getClientIp(request)}`, {
            limit: 480,
            windowMs: WINDOW_MS,
        }),
    ]);
    for (const limit of limits) assertRateLimitAllowed(limit);

    const parsed = roomBody.safeParse(await request.json().catch(() => null));
    const roomKey = parsed.success
        ? recorderRoomKeyFor(parsed.data.room)
        : null;
    if (!roomKey)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid recorder room",
            400,
        );

    return NextResponse.json(await queryRoomRecorders(userId, roomKey));
});
