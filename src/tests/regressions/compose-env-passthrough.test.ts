/**
 * Regression test: docker-compose.yml injects into the app only the
 * variables listed under its `environment:`. These self-host variables were
 * documented in `.env.example` and the docs but never listed, so setting
 * them did nothing in a container. Each fallback must equal the app's own
 * default, because an unset `.env` value reaches the app as that fallback.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
    process.env.NEXT_PHASE = "phase-production-build";
});

import { envSchema } from "@/lib/env";

const compose = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8");

const PASSED = [
    "RECORDER_AUTO_RECORD_PLATFORMS",
    "RECORDER_AUTO_STOP_QUIET_SECONDS",
    "RECORDER_NOTICE_TEXT",
    "RECORDER_LOCK_DEFAULTS",
    "DISABLE_UPDATE_CHECK",
    "WEBHOOKS_REQUIRE_PUBLIC_TARGETS",
    "BACKGROUND_SYNC_ENABLED",
    "BACKGROUND_SYNC_INTERVAL_MS",
    "PLAUD_SYNC_RATE_LIMIT_PER_MINUTE",
    "WEBSHARE_API_KEY",
    "PLAUD_PROXY_SCOPE",
    "VIDEO_UPLOAD_MAX_BYTES",
    "WHISPER_MAX_BYTES",
    "WHISPER_COMPRESS_BITRATE_KBPS",
    "WHISPER_REQUEST_TIMEOUT_MS",
    "AUTO_SUMMARY_RATE_LIMIT_PER_HOUR",
] as const;

function composeFallback(key: string): string | undefined {
    const line = new RegExp(`^\\s+${key}: \\$\\{${key}:-([^}]*)\\}$`, "m");
    return compose.match(line)?.[1];
}

describe("compose passes the documented self-host variables to the app", () => {
    it.each(PASSED)("%s falls back to the app's own default", (key) => {
        const fallback = composeFallback(key);
        expect(fallback, `${key} is not passed to the app`).toBeDefined();
        expect(envSchema.parse({ [key]: fallback })[key]).toEqual(
            envSchema.parse({})[key],
        );
    });

    it("passes BACKUP_STORAGE_PATH, unset meaning beside the recordings", () => {
        expect(composeFallback("BACKUP_STORAGE_PATH")).toBe("");
        expect(
            envSchema.parse({ BACKUP_STORAGE_PATH: "" }).BACKUP_STORAGE_PATH,
        ).toBeFalsy();
    });

    it("mounts a configured backup path at the same path in the container", () => {
        expect(compose).toContain(
            `- \${BACKUP_STORAGE_PATH:-backups}:\${BACKUP_STORAGE_PATH:-/app/backups}`,
        );
        expect(compose).toMatch(/^\s{2}backups:\s*$/m);
    });

    it("keeps API_TOKEN_HASH_SECRET out of the app environment", () => {
        expect(compose).not.toMatch(/^\s+API_TOKEN_HASH_SECRET:/m);
    });
});
