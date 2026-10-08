import { AppError, ErrorCode } from "@/lib/errors";
import {
    ACCEPTED_SESSION_MIME_TYPES,
    MAX_CHANNEL_LABEL_LENGTH,
    MAX_CHANNELS,
    MAX_CHUNK_INDEX,
    MAX_CLIENT_VERSION_LENGTH,
    MAX_PLATFORM_HINT_LENGTH,
    STOP_REASONS,
} from "./constants";

/** Capture facts the extension declares when it opens a session. */
export interface RecordingSessionMetadata {
    /** Label per audio channel, in channel order, e.g. `["microphone", "system"]`. */
    channelLayout: string[];
    /** Where the meeting ran, when the client could tell: `google-meet`, `zoom`, `teams`. */
    platformHint?: string;
    clientVersion?: string;
    /** Client's UTC offset in minutes at start, used only to name the recording in local time. */
    timezoneOffsetMinutes?: number;
}

export interface CreateRecordingSessionInput {
    mimeType: string;
    metadata: RecordingSessionMetadata;
    startedAt: Date;
    noticeAcknowledgedAt: Date | null;
}

export interface CompleteRecordingSessionInput {
    chunkCount: number;
    endedAt: Date;
    stopReason: string;
}

function invalid(message: string, field: string): AppError {
    return new AppError(ErrorCode.INVALID_INPUT, message, 400, { field });
}

function parseDate(value: unknown, field: string, required: true): Date;
function parseDate(value: unknown, field: string, required: false): Date | null;
function parseDate(value: unknown, field: string, required: boolean) {
    if (value == null || value === "") {
        if (required) {
            throw new AppError(
                ErrorCode.MISSING_REQUIRED_FIELD,
                `${field} is required`,
                400,
                { field },
            );
        }
        return null;
    }
    if (typeof value !== "string") {
        throw invalid(`${field} must be an ISO timestamp`, field);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw invalid(`${field} must be an ISO timestamp`, field);
    }
    return date;
}

function parseOptionalString(
    value: unknown,
    field: string,
    maxLength: number,
): string | undefined {
    if (value == null || value === "") return undefined;
    if (typeof value !== "string") {
        throw invalid(`${field} must be a string`, field);
    }
    const trimmed = value.trim();
    if (trimmed.length > maxLength) {
        throw invalid(
            `${field} must be ${maxLength} characters or less`,
            field,
        );
    }
    return trimmed;
}

/** `audio/webm;codecs=opus` -> `audio/webm`. */
export function normalizeMimeType(value: string): string {
    return value.split(";")[0].trim().toLowerCase();
}

export function parseCreateRecordingSessionBody(
    body: unknown,
): CreateRecordingSessionInput {
    const raw = (body ?? {}) as Record<string, unknown>;

    if (typeof raw.mimeType !== "string" || raw.mimeType.trim() === "") {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "mimeType is required",
            400,
            { field: "mimeType" },
        );
    }
    const mimeType = normalizeMimeType(raw.mimeType);
    if (!ACCEPTED_SESSION_MIME_TYPES.has(mimeType)) {
        throw new AppError(
            ErrorCode.INVALID_FILE_FORMAT,
            `Unsupported mimeType. Use one of: ${[...ACCEPTED_SESSION_MIME_TYPES].join(", ")}`,
            400,
            { field: "mimeType" },
        );
    }

    if (!Array.isArray(raw.channelLayout) || raw.channelLayout.length === 0) {
        throw invalid(
            "channelLayout must be a non-empty array of channel labels",
            "channelLayout",
        );
    }
    if (raw.channelLayout.length > MAX_CHANNELS) {
        throw invalid(
            `channelLayout may list at most ${MAX_CHANNELS} channels`,
            "channelLayout",
        );
    }
    const channelLayout = raw.channelLayout.map((label) => {
        if (
            typeof label !== "string" ||
            label.trim() === "" ||
            label.length > MAX_CHANNEL_LABEL_LENGTH
        ) {
            throw invalid(
                `channelLayout labels must be strings of at most ${MAX_CHANNEL_LABEL_LENGTH} characters`,
                "channelLayout",
            );
        }
        return label.trim();
    });

    let timezoneOffsetMinutes: number | undefined;
    if (raw.timezoneOffsetMinutes != null) {
        const offset = raw.timezoneOffsetMinutes;
        if (
            typeof offset !== "number" ||
            !Number.isInteger(offset) ||
            Math.abs(offset) > 14 * 60
        ) {
            throw invalid(
                "timezoneOffsetMinutes must be an integer between -840 and 840",
                "timezoneOffsetMinutes",
            );
        }
        timezoneOffsetMinutes = offset;
    }

    const metadata: RecordingSessionMetadata = { channelLayout };
    const platformHint = parseOptionalString(
        raw.platformHint,
        "platformHint",
        MAX_PLATFORM_HINT_LENGTH,
    );
    if (platformHint) metadata.platformHint = platformHint;
    const clientVersion = parseOptionalString(
        raw.clientVersion,
        "clientVersion",
        MAX_CLIENT_VERSION_LENGTH,
    );
    if (clientVersion) metadata.clientVersion = clientVersion;
    if (timezoneOffsetMinutes !== undefined) {
        metadata.timezoneOffsetMinutes = timezoneOffsetMinutes;
    }

    return {
        mimeType,
        metadata,
        startedAt: parseDate(raw.startedAt, "startedAt", true),
        noticeAcknowledgedAt: parseDate(
            raw.noticeAcknowledgedAt,
            "noticeAcknowledgedAt",
            false,
        ),
    };
}

export function parseCompleteRecordingSessionBody(
    body: unknown,
): CompleteRecordingSessionInput {
    const raw = (body ?? {}) as Record<string, unknown>;

    const chunkCount = raw.chunkCount;
    if (
        typeof chunkCount !== "number" ||
        !Number.isInteger(chunkCount) ||
        chunkCount < 1 ||
        chunkCount > MAX_CHUNK_INDEX + 1
    ) {
        throw invalid(
            `chunkCount must be an integer from 1 to ${MAX_CHUNK_INDEX + 1}`,
            "chunkCount",
        );
    }

    let stopReason = "unknown";
    if (raw.stopReason != null) {
        if (typeof raw.stopReason !== "string") {
            throw invalid("stopReason must be a string", "stopReason");
        }
        if (!STOP_REASONS.has(raw.stopReason)) {
            throw invalid(
                `stopReason must be one of: ${[...STOP_REASONS].join(", ")}`,
                "stopReason",
            );
        }
        stopReason = raw.stopReason;
    }

    return {
        chunkCount,
        endedAt: parseDate(raw.endedAt, "endedAt", false) ?? new Date(),
        stopReason,
    };
}

/** Parse a chunk index path segment. */
export function parseChunkIndex(value: string): number {
    if (!/^\d{1,5}$/.test(value)) {
        throw invalid(
            `chunk index must be an integer from 0 to ${MAX_CHUNK_INDEX}`,
            "index",
        );
    }
    const index = Number.parseInt(value, 10);
    if (index > MAX_CHUNK_INDEX) {
        throw invalid(
            `chunk index must be an integer from 0 to ${MAX_CHUNK_INDEX}`,
            "index",
        );
    }
    return index;
}

/** Validate a lowercase hex SHA-256 digest. */
export function parseSha256(value: string | null): string {
    if (!value) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "X-Chunk-SHA256 header is required",
            400,
            { field: "X-Chunk-SHA256" },
        );
    }
    const normalized = value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized)) {
        throw invalid(
            "X-Chunk-SHA256 must be a 64-character hex digest",
            "X-Chunk-SHA256",
        );
    }
    return normalized;
}

const PLATFORM_LABELS: Record<string, string> = {
    "google-meet": "Google Meet",
    meet: "Google Meet",
    zoom: "Zoom",
    teams: "Microsoft Teams",
    "microsoft-teams": "Microsoft Teams",
    webex: "Webex",
    slack: "Slack",
    discord: "Discord",
};

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

/**
 * Human-readable recording title, e.g. `Meeting (Zoom) 2026-09-18 14-30`.
 *
 * Formatted in the client's local time when it told us its offset, because
 * "the 14:30 meeting" is how the user will look for it.
 */
export function buildMeetingTitle(
    metadata: RecordingSessionMetadata,
    startedAt: Date,
): string {
    const offsetMs = (metadata.timezoneOffsetMinutes ?? 0) * 60 * 1000;
    const local = new Date(startedAt.getTime() + offsetMs);
    const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
    const time = `${pad(local.getUTCHours())}-${pad(local.getUTCMinutes())}`;
    const hint = metadata.platformHint?.toLowerCase();
    const platform = hint ? PLATFORM_LABELS[hint] : undefined;
    const label = platform ? `Meeting (${platform})` : "Meeting";
    return `${label} ${date} ${time}`;
}

/** Restore typed metadata from the jsonb column, tolerating older shapes. */
export function readRecordingSessionMetadata(
    raw: Record<string, unknown>,
): RecordingSessionMetadata {
    const channelLayout = Array.isArray(raw.channelLayout)
        ? raw.channelLayout.filter(
              (label): label is string => typeof label === "string",
          )
        : [];
    const metadata: RecordingSessionMetadata = { channelLayout };
    if (typeof raw.platformHint === "string") {
        metadata.platformHint = raw.platformHint;
    }
    if (typeof raw.clientVersion === "string") {
        metadata.clientVersion = raw.clientVersion;
    }
    if (typeof raw.timezoneOffsetMinutes === "number") {
        metadata.timezoneOffsetMinutes = raw.timezoneOffsetMinutes;
    }
    return metadata;
}
