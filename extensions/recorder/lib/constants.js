// Shared constants for the Chatterbox Meeting Recorder extension.
// Kept in sync with the server's src/lib/recording-sessions/constants.ts and
// src/lib/recorder/config.ts.

/** Encoder slice length. Each slice becomes one uploaded chunk. */
export const CHUNK_INTERVAL_MS = 5000;

/** Server's per-chunk ceiling. */
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

/** Recorder output container and codec. */
export const RECORDER_MIME_TYPE = "audio/webm;codecs=opus";

/** What we tell the server the container is. */
export const SESSION_MIME_TYPE = "audio/webm";

/**
 * How the two sources are laid out in the recording.
 *
 * "mixed": microphone and system audio summed and centered -- what a normal
 *   recorder produces, and what sounds right on headphones. The default.
 * "split": microphone on the left channel, system audio on the right, so a
 *   later step could separate "you" from "the others". Sounds one-sided on
 *   headphones, so it is opt-in.
 */
export const DEFAULT_CHANNEL_MODE = "mixed";
export const CHANNEL_LAYOUT_MIXED = ["mixed"];
export const CHANNEL_LAYOUT_SPLIT = ["microphone", "system"];

/** Target Opus bitrate. 128 kbps is transparent for speech and light music. */
export const AUDIO_BITS_PER_SECOND = 128_000;

/** Capture and encode sample rate. */
export const SAMPLE_RATE = 48_000;

/** chrome.storage.local keys. */
export const STORAGE_KEYS = {
    serverUrl: "serverUrl",
    encryptedApiKey: "encryptedApiKey",
    installationId: "installationId",
    microphoneId: "microphoneId",
    micReminderDismissed: "micReminderDismissed",
    microphoneSetupSkipped: "microphoneSetupSkipped",
    noticeText: "noticeText",
    channelMode: "channelMode",
    /** { [platformId]: "off" | "prompt" | "auto" } -- the user's own choices. */
    platformModes: "platformModes",
    /** Last config fetched from the server, or null. */
    serverDefaults: "serverDefaults",
    nudgeEnabled: "nudgeEnabled",
    agendaReminders: "agendaReminders",
    agendaBanner: "agendaBanner",
    /** User override for the auto-stop quiet period, or null for server/default. */
    autoStopQuietSeconds: "autoStopQuietSeconds",
    /** ISO timestamp of the one-time auto-mode policy acknowledgement. */
    autoModeAcknowledgedAt: "autoModeAcknowledgedAt",
    /** ISO timestamp of explicit extension data-use consent. */
    dataUseAcknowledgedAt: "dataUseAcknowledgedAt",
    /** Folder selected in the popup, or null to file later. */
    folderId: "folderId",
    /** Display label for the selected folder, or null to file later. */
    folderLabel: "folderLabel",
};

/** The recorder window's width once Chrome's sharing dialog has closed. */
export const RECORDER_WINDOW_WIDTH = 430;

/**
 * The recorder window's size while Chrome's sharing dialog is open. On macOS
 * and Linux Chrome draws that dialog inside the window and clips it there.
 */
export const PICKER_WINDOW_SIZE = { width: 800, height: 680 };

/** Per-platform recording modes. */
export const PLATFORM_MODES = ["off", "prompt", "auto"];
export const DEFAULT_PLATFORM_MODE = "off";
export const PROMPT_PLATFORMS = ["google-meet", "teams", "zoom"];
export const SETUP_FLOW_KEY = "recorderSetupFlow";

export const DEFAULT_AUTO_STOP_QUIET_SECONDS = 180;

export const DEFAULT_NOTICE_TEXT =
    "Inform participants and obtain any required consent before recording.";

/** chrome.alarms names. */
export const ALARMS = {
    configRefresh: "config-refresh",
    uploadRetry: "upload-retry",
    /** `quiet:<tabId>` -- fires when an auto recording's tab has been silent long enough. */
    quietPrefix: "quiet:",
};

/** Message types shared with the Chatterbox web app (page <-> extension). */
export const MESSAGES = {
    ping: "riffado-recorder-ping",
    present: "riffado-recorder-present",
    pair: "riffado-recorder-pair",
    pairResult: "riffado-recorder-pair-result",
};

/** Recording state machine values, mirrored into chrome.storage.session. */
export const STATE = {
    idle: "idle",
    awaitingPicker: "awaiting-picker",
    recording: "recording",
    finalizing: "finalizing",
    completed: "completed",
    error: "error",
};
