import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: {
        APP_URL: "https://riffado.example.com",
        RECORDER_AUTO_RECORD_PLATFORMS: ["google-meet", "zoom", "bogus"],
        RECORDER_AUTO_STOP_QUIET_SECONDS: 240,
        RECORDER_NOTICE_TEXT: undefined,
        RECORDER_LOCK_DEFAULTS: true,
        NEXT_PUBLIC_RECORDER_EXTENSION_ID: undefined,
    },
}));

import {
    DEFAULT_RECORDER_EXTENSION_ID,
    DEFAULT_RECORDER_NOTICE_TEXT,
    getRecorderServerConfig,
    resolveAutoRecordPlatforms,
    serializeRecorderServerConfig,
} from "@/lib/recorder/config";
import { RECORDER_PLATFORM_IDS } from "@/lib/recorder/platforms";

describe("resolveAutoRecordPlatforms", () => {
    it("expands 'all' to every known platform", () => {
        expect(resolveAutoRecordPlatforms(["all"]).platforms).toEqual([
            ...RECORDER_PLATFORM_IDS,
        ]);
    });

    it("keeps known ids, reports unknown ones, de-duplicates", () => {
        const result = resolveAutoRecordPlatforms([
            "zoom",
            "teams",
            "zoom",
            "nope",
        ]);
        expect(result.platforms).toEqual(["zoom", "teams"]);
        expect(result.unknown).toEqual(["nope"]);
    });

    it("is empty when nothing is configured", () => {
        expect(resolveAutoRecordPlatforms([])).toEqual({
            platforms: [],
            unknown: [],
        });
    });
});

describe("getRecorderServerConfig", () => {
    it("reads env, drops unknown platforms, and applies defaults", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const config = getRecorderServerConfig();
        expect(config.extensionId).toBe(DEFAULT_RECORDER_EXTENSION_ID);
        expect(config.serverUrl).toBe("https://riffado.example.com");
        expect(config.defaults.autoRecordPlatforms).toEqual([
            "google-meet",
            "zoom",
        ]);
        expect(config.defaults.autoStopQuietSeconds).toBe(240);
        expect(config.defaults.noticeText).toBe(DEFAULT_RECORDER_NOTICE_TEXT);
        expect(config.defaults.lockDefaults).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("bogus"));
        warn.mockRestore();
    });

    it("serializes to the snake_case wire shape", () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const wire = serializeRecorderServerConfig(getRecorderServerConfig());
        expect(wire.extension_id).toBe(DEFAULT_RECORDER_EXTENSION_ID);
        expect(wire.defaults.auto_record_platforms).toEqual([
            "google-meet",
            "zoom",
        ]);
        expect(wire.defaults.lock_defaults).toBe(true);
        expect(wire.platforms.map((p) => p.id)).toEqual([
            ...RECORDER_PLATFORM_IDS,
        ]);
    });
});
