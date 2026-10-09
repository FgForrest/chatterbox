// Typed accessors over chrome.storage.local for extension settings, plus the
// merge of server-pushed defaults with the user's own choices.

import {
    DEFAULT_AUTO_STOP_QUIET_SECONDS,
    DEFAULT_CHANNEL_MODE,
    DEFAULT_DOWNLOAD_FOLDER,
    DEFAULT_LOCAL_COPY_POLICY,
    DEFAULT_NOTICE_TEXT,
    DEFAULT_PLATFORM_MODE,
    PLATFORM_MODES,
    STORAGE_KEYS,
} from "./constants.js";
import { PLATFORM_IDS } from "./platforms.js";

/**
 * @typedef {Object} ServerDefaults
 * @property {string[]} autoRecordPlatforms
 * @property {number} autoStopQuietSeconds
 * @property {string} noticeText
 * @property {boolean} lockDefaults
 * @property {string} fetchedAt
 */

/**
 * @typedef {Object} RecorderSettings
 * @property {string} serverUrl
 * @property {string} apiKey
 * @property {string} microphoneId
 * @property {"always"|"never"|"ask"} localCopyPolicy
 * @property {string|null} noticeText         user override, null = server/default
 * @property {string} downloadFolder
 * @property {"mixed"|"split"} channelMode
 * @property {Record<string, "off"|"prompt"|"auto">} platformModes
 * @property {ServerDefaults|null} serverDefaults
 * @property {boolean} nudgeEnabled
 * @property {number|null} autoStopQuietSeconds
 * @property {string|null} autoModeAcknowledgedAt
 */

/** @returns {Promise<RecorderSettings>} */
export async function getSettings() {
    const raw = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
    return {
        serverUrl: (raw[STORAGE_KEYS.serverUrl] ?? "").replace(/\/+$/, ""),
        apiKey: raw[STORAGE_KEYS.apiKey] ?? "",
        microphoneId: raw[STORAGE_KEYS.microphoneId] ?? "",
        localCopyPolicy:
            raw[STORAGE_KEYS.localCopyPolicy] ?? DEFAULT_LOCAL_COPY_POLICY,
        noticeText: raw[STORAGE_KEYS.noticeText] ?? null,
        downloadFolder:
            raw[STORAGE_KEYS.downloadFolder] ?? DEFAULT_DOWNLOAD_FOLDER,
        channelMode: raw[STORAGE_KEYS.channelMode] ?? DEFAULT_CHANNEL_MODE,
        platformModes: raw[STORAGE_KEYS.platformModes] ?? {},
        serverDefaults: raw[STORAGE_KEYS.serverDefaults] ?? null,
        nudgeEnabled: raw[STORAGE_KEYS.nudgeEnabled] ?? true,
        autoStopQuietSeconds: raw[STORAGE_KEYS.autoStopQuietSeconds] ?? null,
        autoModeAcknowledgedAt: raw[STORAGE_KEYS.autoModeAcknowledgedAt] ?? null,
    };
}

/** @param {Partial<RecorderSettings>} patch */
export async function saveSettings(patch) {
    const mapped = {};
    for (const [key, value] of Object.entries(patch)) {
        if (key in STORAGE_KEYS) mapped[STORAGE_KEYS[key]] = value;
    }
    await chrome.storage.local.set(mapped);
}

/** Whether pairing (server URL + key) is complete. */
export async function isPaired() {
    const { serverUrl, apiKey } = await getSettings();
    return Boolean(serverUrl && apiKey);
}

/** @param {RecorderSettings} settings */
export function effectiveNoticeText(settings) {
    return (
        settings.noticeText ||
        settings.serverDefaults?.noticeText ||
        DEFAULT_NOTICE_TEXT
    );
}

/** @param {RecorderSettings} settings */
export function effectiveQuietSeconds(settings) {
    return (
        settings.autoStopQuietSeconds ??
        settings.serverDefaults?.autoStopQuietSeconds ??
        DEFAULT_AUTO_STOP_QUIET_SECONDS
    );
}

/**
 * The mode that applies to each platform, and where it came from.
 *
 * Precedence: a locked server default beats everything; otherwise the user's
 * choice beats the server default, which beats "off".
 *
 * @param {RecorderSettings} settings
 * @returns {Record<string, {mode: "off"|"prompt"|"auto", source: "locked"|"user"|"server"|"default"}>}
 */
export function effectivePlatformModes(settings) {
    const server = settings.serverDefaults;
    const serverAuto = new Set(server?.autoRecordPlatforms ?? []);
    const result = {};
    for (const id of PLATFORM_IDS) {
        const userMode = settings.platformModes[id];
        if (server?.lockDefaults && serverAuto.has(id)) {
            result[id] = { mode: "auto", source: "locked" };
        } else if (userMode && PLATFORM_MODES.includes(userMode)) {
            result[id] = { mode: userMode, source: "user" };
        } else if (serverAuto.has(id)) {
            result[id] = { mode: "auto", source: "server" };
        } else {
            result[id] = { mode: DEFAULT_PLATFORM_MODE, source: "default" };
        }
    }
    return result;
}

/** @param {RecorderSettings} settings */
export function anyPlatformAuto(settings) {
    return Object.values(effectivePlatformModes(settings)).some(
        (entry) => entry.mode === "auto",
    );
}
