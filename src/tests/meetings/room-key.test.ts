import { expect, it, vi } from "vitest";
import { recorderRoomKey, recorderRoomKeyFor } from "@/lib/meetings/room-key";

vi.mock("@/lib/env", () => ({
    env: { BETTER_AUTH_SECRET: "room-key-test-secret" },
}));

it.each([
    [
        "meet:abc-defg-hij",
        ["meet:abc-defg-hij\n", "meet:ABC-DEFG-HIJ", "meet:abc-defg-hij?x=1"],
    ],
    ["zoom:12345678901", ["zoom:123abc", "zoom:123/456", "zoom:123?pwd=456"]],
    [
        "teams:19:meeting_U2Vzc2lvbg-A_1@thread.v2",
        [
            "teams:19:meeting_A%2FB@thread.v2",
            "teams:19:meeting_@thread.v2",
            "teams:19:meeting_X@thread.v1",
        ],
    ],
    [
        "teams:12345678901",
        ["teams:12345678901?p=secret", "teams:call", "teams:/meet/123"],
    ],
    [
        "webex:acme/meeting-room",
        [
            "webex:meeting-room",
            "webex:acme/meet/room",
            "webex:acme.example.com/room",
        ],
    ],
    [
        "slack:T01234/C56789",
        ["slack:C56789", "slack:T01234/C56789/extra", "slack:t01234/c56789"],
    ],
    [
        "whereby:acme.whereby.com/team-room",
        [
            "whereby:example.com/team-room",
            "whereby:whereby.com/team-room?roomKey=secret",
            "whereby:whereby.com/",
        ],
    ],
    [
        "jitsi:team-room",
        [
            "jitsi:meet.jit.si/team-room",
            "jitsi:team.room",
            "jitsi:team-room#config",
        ],
    ],
])("validates the canonical room %s", (room, bad) => {
    expect(recorderRoomKeyFor(room)).toMatch(/^[a-f0-9]{64}$/);
    for (const value of bad) expect(recorderRoomKeyFor(value)).toBeNull();
});

it("retains Meet agenda keys and separates opaque provider identifiers", () => {
    expect(recorderRoomKeyFor("meet:abc-defg-hij")).toBe(
        recorderRoomKey("abc-defg-hij"),
    );
    expect(recorderRoomKeyFor("zoom:123")).not.toBe(
        recorderRoomKeyFor("teams:123"),
    );
    expect(recorderRoomKeyFor("teams:19:meeting_X@thread.v2")).not.toBe(
        recorderRoomKeyFor("teams:19:meeting_x@thread.v2"),
    );
    for (const bad of [
        null,
        "zoom",
        "jitsix",
        "https://zoom.us/j/123",
        "toString:123",
        `zoom:${"1".repeat(257)}`,
    ])
        expect(recorderRoomKeyFor(bad)).toBeNull();
});
