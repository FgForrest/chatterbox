import { fetchWithoutIdleTimeout } from "@/lib/ai/provider-fetch";
import { withResponseUsage } from "@/lib/ai/usage-values";
import { env } from "@/lib/env";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const ERROR_DETAIL_MAX_CHARS = 200;

export interface GeminiTranscribeArgs {
    apiKey: string;
    model: string;
    audioBuffer: Buffer;
    contentType: string;
    language?: string;
    attempt?: <T>(run: () => Promise<T>) => Promise<T>;
}

export interface GeminiTranscribeResult {
    text: string;
    detectedLanguage: string | null;
    inputTokens?: number;
    outputTokens?: number;
}

// Maps Node.js/HTTP content-type strings to Gemini-accepted MIME types.
// Gemini supports a wider set than Whisper; list all known voice formats.
const MIME_TYPE_MAP: Record<string, string> = {
    "audio/mpeg": "audio/mpeg",
    "audio/mp3": "audio/mpeg",
    "audio/mp4": "audio/mp4",
    "audio/wav": "audio/wav",
    "audio/x-wav": "audio/wav",
    "audio/wave": "audio/wav",
    "audio/ogg": "audio/ogg",
    "audio/opus": "audio/opus",
    "audio/flac": "audio/flac",
    "audio/aac": "audio/aac",
    "audio/webm": "audio/webm",
};

const INLINE_DATA_LIMIT_BYTES = 20 * 1024 * 1024; // 20 MB

const TRANSCRIBE_INSTRUCTION =
    "Transcribe the attached audio verbatim. Output only the transcript text — no preamble, no summary, no timestamps, no speaker labels, no markdown.";

// A model id, optionally as the resource name the API also takes
// ("models/gemini-3.8-flash").
const MODEL_NAME = /^(?:(?:models|tunedModels)\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Finish reasons for which Gemini withholds the candidate's text.
const BLOCKED_FINISH_REASONS = new Set([
    "SAFETY",
    "RECITATION",
    "LANGUAGE",
    "BLOCKLIST",
    "PROHIBITED_CONTENT",
    "SPII",
]);

interface GeminiPart {
    text?: string;
    thought?: boolean;
}

interface GeminiGenerateContentResponse {
    candidates?: {
        content?: { parts?: GeminiPart[] };
        finishReason?: string;
        finishMessage?: string;
    }[];
    promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
    usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
    };
}

export class GeminiTranscribeFormatError extends Error {
    constructor(public contentType: string) {
        super(
            `Google Gemini transcription does not support the audio format "${contentType}". ` +
                `Supported formats: mp3, mp4, wav, ogg, opus, flac, aac, webm.`,
        );
        this.name = "GeminiTranscribeFormatError";
    }
}

export class GeminiTranscribeSizeError extends Error {
    constructor(public sizeBytes: number) {
        super(
            `Audio file (${Math.round(sizeBytes / 1024 / 1024)} MB) exceeds the ` +
                `${INLINE_DATA_LIMIT_BYTES / 1024 / 1024} MB inline limit for Google Gemini. ` +
                `Google File API upload support is planned for a future release.`,
        );
        this.name = "GeminiTranscribeSizeError";
    }
}

/**
 * Google Gemini refused the request or returned no transcript: `status` is
 * the HTTP status, or null when the request was never sent (a malformed
 * model id) or succeeded without text (blocked content).
 */
export class GeminiTranscribeError extends Error {
    constructor(
        public status: number | null,
        message: string,
    ) {
        super(message);
        this.name = "GeminiTranscribeError";
    }
}

/**
 * Transcribe audio with Google Gemini's native `generateContent` API, the
 * audio sent inline as base64. The API key goes in the `x-goog-api-key`
 * header, never in the URL. Output usage counts the model's thinking
 * tokens, which Google bills as output.
 */
export async function geminiTranscribe({
    apiKey,
    model,
    audioBuffer,
    contentType,
    language,
    attempt = (run) => run(),
}: GeminiTranscribeArgs): Promise<GeminiTranscribeResult> {
    const mimeType = MIME_TYPE_MAP[contentType.toLowerCase()];
    if (!mimeType) {
        throw new GeminiTranscribeFormatError(contentType);
    }

    if (audioBuffer.byteLength > INLINE_DATA_LIMIT_BYTES) {
        throw new GeminiTranscribeSizeError(audioBuffer.byteLength);
    }

    const name = model.trim();
    if (!MODEL_NAME.test(name)) {
        throw new GeminiTranscribeError(
            null,
            `"${model}" is not a Google Gemini model id.`,
        );
    }
    const resource = name.includes("/") ? name : `models/${name}`;

    const prompt = language
        ? `${TRANSCRIBE_INSTRUCTION} The audio language is ${language}.`
        : TRANSCRIBE_INSTRUCTION;

    return attempt(async () => {
        const response = await fetchWithoutIdleTimeout(
            `${API_BASE}/${resource}:generateContent`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": apiKey,
                },
                body: JSON.stringify({
                    contents: [
                        {
                            role: "user",
                            parts: [
                                { text: prompt },
                                {
                                    inlineData: {
                                        mimeType,
                                        data: audioBuffer.toString("base64"),
                                    },
                                },
                            ],
                        },
                    ],
                }),
                signal: AbortSignal.timeout(env.WHISPER_REQUEST_TIMEOUT_MS),
            },
        );

        if (!response.ok) {
            const failureUsage = await response
                .clone()
                .json()
                .catch(() => null);
            throw withResponseUsage(
                new GeminiTranscribeError(
                    response.status,
                    await describeError(response, name),
                ),
                failureUsage,
            );
        }

        const payload =
            (await response.json()) as GeminiGenerateContentResponse;
        const candidate = payload.candidates?.[0];
        const blocked = blockedReason(payload);
        if (blocked) {
            throw withResponseUsage(
                new GeminiTranscribeError(
                    null,
                    `Google Gemini withheld the transcription: ${blocked}.`,
                ),
                payload,
            );
        }

        const text = (candidate?.content?.parts ?? [])
            .filter((part) => !part.thought && typeof part.text === "string")
            .map((part) => part.text)
            .join("")
            .trim();
        if (!text) {
            throw withResponseUsage(
                new GeminiTranscribeError(
                    null,
                    "Google Gemini returned an empty transcription. The audio may be silent or the model may not have recognised the content.",
                ),
                payload,
            );
        }

        const usage = payload.usageMetadata;
        return {
            text,
            detectedLanguage: language ?? null,
            inputTokens: usage?.promptTokenCount,
            outputTokens: usage
                ? (usage.candidatesTokenCount ?? 0) +
                  (usage.thoughtsTokenCount ?? 0)
                : undefined,
        };
    });
}

function blockedReason(payload: GeminiGenerateContentResponse): string | null {
    const candidate = payload.candidates?.[0];
    if (!candidate) {
        const feedback = payload.promptFeedback;
        if (!feedback?.blockReason) return null;
        return feedback.blockReasonMessage
            ? `${feedback.blockReason} (${feedback.blockReasonMessage})`
            : feedback.blockReason;
    }
    const reason = candidate.finishReason;
    if (!reason || !BLOCKED_FINISH_REASONS.has(reason)) return null;
    return candidate.finishMessage
        ? `${reason} (${candidate.finishMessage})`
        : reason;
}

async function describeError(
    response: Response,
    model: string,
): Promise<string> {
    const body = await response.text().catch(() => "");
    const { message, keyInvalid } = parseError(body);
    const suffix = message ? ` ${message}` : "";

    if (keyInvalid) {
        return `Google Gemini rejected the API key.${suffix}`;
    }
    switch (response.status) {
        case 401:
        case 403:
            return `Google Gemini rejected the API key.${suffix}`;
        case 404:
            return `Google Gemini does not serve the model "${model}" (it may have been retired). Pick another model in Settings → Providers.${suffix}`;
        case 413:
            return `Google Gemini rejected the recording as too large.${suffix}`;
        case 429:
            return `Google Gemini rate limit or quota reached.${suffix}`;
        default:
            return `Google Gemini returned ${response.status}.${suffix}`;
    }
}

function parseError(body: string): {
    message: string | null;
    keyInvalid: boolean;
} {
    if (!body) {
        return { message: null, keyInvalid: false };
    }
    try {
        const parsed = JSON.parse(body) as {
            error?: { message?: unknown; details?: unknown };
        };
        const message = parsed.error?.message;
        const details = Array.isArray(parsed.error?.details)
            ? (parsed.error.details as { reason?: unknown }[])
            : [];
        return {
            message:
                typeof message === "string"
                    ? message.slice(0, ERROR_DETAIL_MAX_CHARS)
                    : null,
            keyInvalid: details.some(
                (detail) => detail?.reason === "API_KEY_INVALID",
            ),
        };
    } catch {
        return {
            message: body.slice(0, ERROR_DETAIL_MAX_CHARS),
            keyInvalid: false,
        };
    }
}
