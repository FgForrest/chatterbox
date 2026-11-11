import { createHmac } from "node:crypto";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import { normalizeRecorderMeetCode } from "@/lib/meetings/room-code";

/** Normalize a room code and keep only its server-keyed, domain-separated lookup hash. */
export function recorderRoomKey(value: unknown): string | null {
    const code = normalizeRecorderMeetCode(value);
    return code
        ? createHmac(
              "sha256",
              Buffer.from(domainLookupHash("recorder-room-key", "v1"), "hex"),
          )
              .update(code)
              .digest("hex")
        : null;
}
