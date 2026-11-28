import { expect, it, vi } from "vitest";
import { recorderRoomKey, recorderRoomKeyFor } from "@/lib/meetings/room-key";
import fixtures from "../fixtures/meeting-room-urls.json";

vi.mock("@/lib/env", () => ({
    env: { BETTER_AUTH_SECRET: "meeting-room-fixture-test-secret" },
}));

it.each(
    fixtures.positive,
)("accepts the extension room for %s", (_url, room) => {
    const key = recorderRoomKeyFor(room);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    if (room.startsWith("meet:")) {
        expect(key).toBe(recorderRoomKey(room.slice("meet:".length)));
    }
});
