import { recordingSessionLeaseRoute } from "@/lib/recording-sessions/lease-route";

/**
 * `POST /api/v1/recording-sessions/{id}/lease`: refresh or move the open
 * capture's 60 s room lease. Takes a newer revision, or the same revision for
 * the same room; an older revision, an ended lease or a session that is no
 * longer open is 409.
 */
export const POST = recordingSessionLeaseRoute("renew");
