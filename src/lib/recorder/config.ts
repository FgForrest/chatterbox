import { env } from "@/lib/env";
import {
    isRecorderPlatformId,
    RECORDER_PLATFORM_IDS,
    RECORDER_PLATFORMS,
    type RecorderPlatformId,
} from "./platforms";

/** Extension id of the published Meeting Recorder build (pinned manifest key). */
export const DEFAULT_RECORDER_EXTENSION_ID = "hiipabbdnlhdkgldhkdndmohejoaecnh";

export const DEFAULT_RECORDER_NOTICE_TEXT =
    "Meetings I record with Riffado are transcribed and summarized. I will inform the other participants before recording.";

export interface RecorderServerConfig {
    extensionId: string;
    serverUrl: string | null;
    defaults: {
        /** Platform ids that default to automatic recording. */
        autoRecordPlatforms: RecorderPlatformId[];
        autoStopQuietSeconds: number;
        noticeText: string;
        lockDefaults: boolean;
    };
    platforms: typeof RECORDER_PLATFORMS;
}

/** Resolve `RECORDER_AUTO_RECORD_PLATFORMS` into concrete ids, dropping unknowns. */
export function resolveAutoRecordPlatforms(raw: readonly string[]): {
    platforms: RecorderPlatformId[];
    unknown: string[];
} {
    if (raw.includes("all")) {
        return { platforms: [...RECORDER_PLATFORM_IDS], unknown: [] };
    }
    const platforms: RecorderPlatformId[] = [];
    const unknown: string[] = [];
    for (const id of raw) {
        if (isRecorderPlatformId(id)) {
            if (!platforms.includes(id)) platforms.push(id);
        } else {
            unknown.push(id);
        }
    }
    return { platforms, unknown };
}

export function recorderExtensionId(): string {
    return (
        env.NEXT_PUBLIC_RECORDER_EXTENSION_ID ?? DEFAULT_RECORDER_EXTENSION_ID
    );
}

/** The config a paired extension fetches. Pure function of env. */
export function getRecorderServerConfig(): RecorderServerConfig {
    const { platforms, unknown } = resolveAutoRecordPlatforms(
        env.RECORDER_AUTO_RECORD_PLATFORMS,
    );
    if (unknown.length > 0) {
        console.warn(
            `[recorder] RECORDER_AUTO_RECORD_PLATFORMS contains unknown ids, ignored: ${unknown.join(", ")}`,
        );
    }
    return {
        extensionId: recorderExtensionId(),
        serverUrl: env.APP_URL ?? null,
        defaults: {
            autoRecordPlatforms: platforms,
            autoStopQuietSeconds: env.RECORDER_AUTO_STOP_QUIET_SECONDS,
            noticeText:
                env.RECORDER_NOTICE_TEXT ?? DEFAULT_RECORDER_NOTICE_TEXT,
            lockDefaults: env.RECORDER_LOCK_DEFAULTS === true,
        },
        platforms: RECORDER_PLATFORMS,
    };
}

/** Snake-case wire shape for `/api/v1/recorder/config`. */
export function serializeRecorderServerConfig(config: RecorderServerConfig) {
    return {
        extension_id: config.extensionId,
        server_url: config.serverUrl,
        defaults: {
            auto_record_platforms: config.defaults.autoRecordPlatforms,
            auto_stop_quiet_seconds: config.defaults.autoStopQuietSeconds,
            notice_text: config.defaults.noticeText,
            lock_defaults: config.defaults.lockDefaults,
        },
        platforms: config.platforms.map((platform) => ({
            id: platform.id,
            name: platform.name,
        })),
    };
}
