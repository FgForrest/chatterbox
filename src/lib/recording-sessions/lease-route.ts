import { NextResponse } from "next/server";
import { z } from "zod";
import {
    endRecordingSessionLease,
    renewRecordingSessionLease,
} from "@/db/queries/recording-session-leases";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { recorderRoomKeyFor } from "@/lib/meetings/room-key";
import { isOrgScopeVisible } from "@/lib/org/config";
import { gateRecordingSessionRequest } from "./route-gate";
import { getRecordingSessionForUser } from "./store";

type IdContext = { params: Promise<{ id: string }> };

const revision = z.number().int().min(0).max(2_147_483_647);
const renewBody = z.strictObject({ revision, room: z.string().nullable() });
const endBody = z.strictObject({ revision });

/** Expose capture leases and their room lookup only in self-host Organization mode. */
export function requireRecorderRooms() {
    if (!isOrgScopeVisible()) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Recorder rooms are unavailable",
            404,
        );
    }
}

/** Use the recorder gate and check the bound credential on every lease update. */
export function recordingSessionLeaseRoute(action: "renew" | "end") {
    return apiHandler<IdContext>(async (request, context) => {
        requireRecorderRooms();
        const gate = await gateRecordingSessionRequest(request);
        if (gate.response) return gate.response;
        const sessionId = (await (context as IdContext).params).id;
        const body: unknown = await request.json().catch(() => null);
        const input = {
            sessionId,
            userId: gate.authn.user.id,
            apiKeyId: gate.authn.apiKeyId,
        };
        let updated: boolean;
        if (action === "renew") {
            const parsed = renewBody.safeParse(body);
            if (!parsed.success)
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "Invalid capture lease",
                    400,
                );
            const { room, revision } = parsed.data;
            const roomKey = recorderRoomKeyFor(room);
            if (room !== null && !roomKey)
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "Invalid recorder room",
                    400,
                );
            updated = await renewRecordingSessionLease(
                { ...input, revision },
                roomKey,
            );
        } else {
            const parsed = endBody.safeParse(body);
            if (!parsed.success)
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "Invalid capture lease end",
                    400,
                );
            updated = await endRecordingSessionLease({
                ...input,
                revision: parsed.data.revision,
            });
        }
        if (!updated) {
            const session = await getRecordingSessionForUser(
                sessionId,
                input.userId,
            );
            if (!session)
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "Recording session not found",
                    404,
                );
            if (session.apiKeyId !== input.apiKeyId)
                throw new AppError(
                    ErrorCode.FORBIDDEN,
                    "Recorder key mismatch",
                    403,
                );
            throw new AppError(
                ErrorCode.RECORDING_LEASE_REFUSED,
                "Capture lease update was refused",
                409,
            );
        }
        return NextResponse.json({ success: true });
    });
}
