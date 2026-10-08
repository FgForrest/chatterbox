import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import {
    getRecorderServerConfig,
    serializeRecorderServerConfig,
} from "@/lib/recorder/config";
import { gateRecordingSessionRequest } from "@/lib/recording-sessions/route-gate";

/**
 * `GET /api/v1/recorder/config` — server defaults for the Meeting Recorder.
 *
 * Fetched by a paired extension at pairing time and then daily. Carries the
 * platforms that default to automatic recording, the auto-stop quiet period,
 * the notice text, and whether users may override those defaults. Requires
 * the recorder key (`recordings:write`).
 */
export const GET = apiHandler(async (request: Request) => {
    const gate = await gateRecordingSessionRequest(request);
    if (gate.response) return gate.response;

    return NextResponse.json(
        serializeRecorderServerConfig(getRecorderServerConfig()),
    );
});
