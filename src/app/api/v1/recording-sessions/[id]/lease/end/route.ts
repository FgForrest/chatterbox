import { recordingSessionLeaseRoute } from "@/lib/recording-sessions/lease-route";

/**
 * `POST /api/v1/recording-sessions/{id}/lease/end`: end the capture's lease
 * for good. Needs a newer revision; later renewals are refused.
 */
export const POST = recordingSessionLeaseRoute("end");
