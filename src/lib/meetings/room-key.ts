import { createHmac } from "node:crypto";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import { normalizeRecorderMeetCode } from "@/lib/meetings/room-code";

const roomPatterns = new Map([
    ["meet", /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/],
    ["zoom", /^[0-9]+$/],
    ["teams", /^(?:[0-9]+|19:meeting_[A-Za-z0-9_-]+@thread\.v2)$/],
    ["webex", /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\/[a-z0-9][a-z0-9._-]*$/],
    ["slack", /^T[A-Z0-9]+\/[CGD][A-Z0-9]+$/],
    [
        "whereby",
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)?whereby\.com\/[a-z0-9][a-z0-9_-]*$/,
    ],
    ["jitsi", /^[a-z0-9][a-z0-9_-]*$/],
]);

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

/** Hash one canonical recorder room, reusing the agenda key for Meet. */
export function recorderRoomKeyFor(room: unknown): string | null {
    if (typeof room !== "string" || room.length > 264 || /\s/.test(room))
        return null;
    const separator = room.indexOf(":");
    if (separator <= 0) return null;
    const platform = room.slice(0, separator);
    const id = room.slice(separator + 1);
    if (id.length > 256 || !roomPatterns.get(platform)?.test(id)) return null;
    if (platform === "meet") return recorderRoomKey(id);
    return createHmac(
        "sha256",
        Buffer.from(domainLookupHash("recorder-room-key", "v1"), "hex"),
    )
        .update(`platform-room\0${room}`)
        .digest("hex");
}
