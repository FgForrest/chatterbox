import type { OpenAI } from "openai";
import { buildChatCompletionParams } from "@/lib/ai/chat-completion-params";
import { withResponseUsage } from "@/lib/ai/usage-values";
import { sniffAudio } from "@/lib/audio/sniff";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import { transcodeToMp3 } from "@/lib/transcription/ffmpeg";

export interface ChatTranscribeArgs {
    client: OpenAI;
    model: string;
    audioBuffer: Buffer;
    contentType: string;
    language?: string;
    attempt?: <T>(run: () => Promise<T>) => Promise<T>;
}

export interface ChatTranscribeResult {
    text: string;
    detectedLanguage: string | null;
    inputTokens?: number;
    outputTokens?: number;
    reportedCostUsd?: number;
}

function contentTypeToAudioFormat(contentType: string): "mp3" | "wav" {
    const ct = contentType.toLowerCase();
    if (ct === "audio/mpeg" || ct === "audio/mp3") return "mp3";
    if (ct === "audio/wav" || ct === "audio/x-wav" || ct === "audio/wave") {
        return "wav";
    }
    throw new ChatTranscribeFormatError(contentType);
}

export class ChatTranscribeFormatError extends Error {
    constructor(
        public contentType: string,
        cause?: string,
    ) {
        super(
            cause
                ? `This transcription provider only accepts mp3 or wav audio (got ${contentType}). Conversion to mp3 failed: ${cause}`
                : `This transcription provider only accepts mp3 or wav audio (got ${contentType}). ` +
                      `Re-upload as mp3/wav, or set a Whisper-compatible provider (OpenAI, Groq, Together AI, ` +
                      `or a local Whisper server) as your default for transcription.`,
        );
        this.name = "ChatTranscribeFormatError";
    }
}

const TRANSCRIBE_INSTRUCTION =
    "Transcribe the attached audio verbatim. Output only the transcript text — no preamble, no summary, no timestamps, no speaker labels, no markdown.";

async function ensureChatCompatibleAudio(
    audioBuffer: Buffer,
    contentType: string,
): Promise<{ buffer: Buffer; format: "mp3" | "wav" }> {
    try {
        return {
            buffer: audioBuffer,
            format: contentTypeToAudioFormat(contentType),
        };
    } catch (error) {
        if (!(error instanceof ChatTranscribeFormatError)) throw error;
        try {
            const mp3 = await transcodeToMp3(audioBuffer);
            return { buffer: mp3, format: "mp3" };
        } catch (transcodeError) {
            throw new ChatTranscribeFormatError(
                contentType,
                transcodeError instanceof Error
                    ? transcodeError.message
                    : String(transcodeError),
            );
        }
    }
}

export async function chatTranscribe({
    client,
    model,
    audioBuffer,
    contentType,
    language,
    attempt = (run) => run(),
}: ChatTranscribeArgs): Promise<ChatTranscribeResult> {
    const sniffed = sniffAudio(audioBuffer);
    const effectiveType =
        sniffed.container === "unknown" ? contentType : sniffed.contentType;
    const { buffer, format } = await ensureChatCompatibleAudio(
        audioBuffer,
        effectiveType,
    );
    const data = buffer.toString("base64");

    const prompt = language
        ? `${TRANSCRIBE_INSTRUCTION} The audio language is ${language}.`
        : TRANSCRIBE_INSTRUCTION;

    return attempt(async () => {
        const response = await client.chat.completions.create(
            buildChatCompletionParams({
                model,
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: prompt },
                            {
                                type: "input_audio",
                                input_audio: { data, format },
                            } as unknown as {
                                type: "text";
                                text: string;
                            },
                        ],
                    },
                ],
            }),
            { timeout: env.WHISPER_REQUEST_TIMEOUT_MS },
        );

        if (response.choices?.[0]?.finish_reason === "length") {
            throw withResponseUsage(
                new AppError(
                    ErrorCode.TRANSCRIPTION_FAILED,
                    "The transcription provider cut off the transcript at its output limit. No partial transcript was saved. Use a provider or model that can return the full recording.",
                    400,
                ),
                response,
            );
        }

        const text = response.choices?.[0]?.message?.content;
        if (typeof text !== "string" || text.trim() === "") {
            throw withResponseUsage(
                new Error(
                    "Transcription provider returned an empty response. The model may not support audio input — pick an audio-capable model.",
                ),
                response,
            );
        }

        return {
            text: text.trim(),
            detectedLanguage: language ?? null,
            inputTokens: response.usage?.prompt_tokens,
            outputTokens: response.usage?.completion_tokens,
            reportedCostUsd: (
                response.usage as
                    | (typeof response.usage & { cost?: number })
                    | undefined
            )?.cost,
        };
    });
}
