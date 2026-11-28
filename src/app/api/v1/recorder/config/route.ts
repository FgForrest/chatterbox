import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import { isOrgScopeVisible } from "@/lib/org/config";
import {
    getRecorderServerConfig,
    serializeRecorderServerConfig,
} from "@/lib/recorder/config";
import { getOrCreateRecorderOfflineKey } from "@/lib/recording-sessions/offline-key";
import { gateRecordingSessionRequest } from "@/lib/recording-sessions/route-gate";

/**
 * `GET /api/v1/recorder/config` — server defaults for the Meeting Recorder.
 *
 * Fetched by a paired extension at pairing time and then daily. Carries the
 * platforms that default to automatic recording, the auto-stop quiet period,
 * the notice text, and whether users may override those defaults. Requires
 * the recorder key (`recordings:write`).
 *
 * Also carries the opaque `account.id` the extension binds offline buffers
 * to, the user's `offlineKey` public descriptor, and the `features` flags the
 * extension gates newer calls on (`roomRecorders` only in self-host
 * Organization mode).
 */
export const GET = apiHandler(async (request: Request) => {
    const gate = await gateRecordingSessionRequest(request);
    if (gate.response) return gate.response;
    const userId = gate.authn.user.id;
    const offlineKey = await getOrCreateRecorderOfflineKey(userId);

    return NextResponse.json({
        ...serializeRecorderServerConfig(getRecorderServerConfig()),
        account: {
            id: createHash("sha256")
                .update(`chatterbox-recorder-account-v1\0${userId}`)
                .digest("base64url"),
        },
        offlineKey,
        features: {
            agendas: true,
            nextMeeting: true,
            agendaLive: true,
            agendaText: 1,
            sessionAgenda: true,
            agendaRooms: 1,
            offlineRecording: 1,
            ...(isOrgScopeVisible() ? { roomRecorders: 1 } : {}),
        },
    });
});
