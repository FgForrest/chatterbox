import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type * as AlmanacTermsModule from "@/lib/transcription/almanac-terms";
import { resolvedAudioProfile } from "@/tests/profiles/seeded-profile-fixture";

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        transaction: vi.fn(),
    },
}));

vi.mock("@/lib/encryption", () => ({
    decrypt: vi.fn().mockReturnValue("sm_speechmatics"),
    encrypt: vi.fn((plaintext: string) => `encrypted:${plaintext}`),
}));

vi.mock("@/lib/encryption/fields", async () => {
    const actual = await vi.importActual<
        typeof import("@/lib/encryption/fields")
    >("@/lib/encryption/fields");
    return {
        ...actual,
        decryptText: vi.fn((value: string) => value),
        encryptText: vi.fn((value: string) => `enc:${value}`),
    };
});

vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        downloadFile: vi.fn().mockResolvedValue(Buffer.from("fake-mp3-bytes")),
    }),
}));

const audioCreate = vi.fn();
const chatCreate = vi.fn();

vi.mock("openai", () => {
    const MockOpenAI = vi.fn(() => ({
        audio: { transcriptions: { create: audioCreate } },
        chat: { completions: { create: chatCreate } },
    }));
    return { OpenAI: MockOpenAI };
});

vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/entitlements", () => ({
    isHostedLockedOut: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/env", () => ({
    env: {
        WHISPER_MAX_BYTES: 24 * 1024 * 1024,
        WHISPER_COMPRESS_BITRATE_KBPS: 12,
        WHISPER_REQUEST_TIMEOUT_MS: 60 * 60 * 1000,
    },
}));

vi.mock("@/lib/hosted/transcription/mynah", () => ({
    isMynahConfigured: vi.fn().mockReturnValue(false),
    transcribeViaMynah: vi.fn(),
}));

vi.mock("@/lib/transcription/ffmpeg", () => ({
    transcodeToMp3: vi.fn(),
    ffmpegToOpus: vi.fn(),
    runFfmpeg: vi.fn(),
}));

vi.mock("@/lib/ai/generate-title", () => ({
    generateTitleFromTranscription: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/plaud/client-factory", () => ({
    createPlaudClient: vi.fn(),
}));

vi.mock("@/lib/folders/item-scope", () => ({
    itemScopeFolderIds: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/integrations/google/meeting-roster", () => ({
    resolveMeetingRoster: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/transcription/almanac-terms", async () => {
    const actual = await vi.importActual<typeof AlmanacTermsModule>(
        "@/lib/transcription/almanac-terms",
    );
    return { ...actual, almanacTermsFor: vi.fn().mockResolvedValue([]) };
});

vi.mock("@/lib/profiles/resolve", () => ({
    resolveItemProfile: vi.fn(async () =>
        resolvedAudioProfile({ defaultTranscriptionLanguage: "cs" }),
    ),
}));
vi.mock("@/lib/pipeline/trigger", () => ({
    requestAdvanceInTx: vi.fn().mockResolvedValue(null),
}));

import { db } from "@/db";
import { resolveMeetingRoster } from "@/lib/integrations/google/meeting-roster";
import { almanacTermsFor } from "@/lib/transcription/almanac-terms";
import { transcribeRecording } from "@/lib/transcription/transcribe-recording";

interface CredentialRow {
    provider: string;
    baseUrl: string | null;
    defaultModel: string | null;
}

function mockDbForCredential(credential: CredentialRow): void {
    (db.select as Mock)
        // recording lookup
        .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                innerJoin: vi.fn().mockReturnValue({
                    where: vi.fn().mockReturnValue({
                        limit: vi.fn().mockResolvedValue([
                            {
                                id: "rec-sm",
                                userId: "user-sm",
                                plaudFileId: "plaud-1",
                                title: "Board meeting",
                                storagePath: "rec-sm.mp3",
                                deletedAt: null,
                            },
                        ]),
                    }),
                }),
            }),
        })
        // existing transcription
        .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([]),
                }),
            }),
        })
        // default transcription credentials
        .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([
                        {
                            id: "creds-sm",
                            userId: "user-sm",
                            apiKey: "encrypted-key",
                            isDefaultTranscription: true,
                            isDefaultEnhancement: false,
                            isDefaultLearn: false,
                            inputUsdPerMillion: null,
                            outputUsdPerMillion: null,
                            audioUsdPerHour: null,
                            disabledAt: null,
                            createdAt: new Date("2026-01-01T00:00:00.000Z"),
                            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
                            ...credential,
                        },
                    ]),
                }),
            }),
        })
        // user settings
        .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([
                        {
                            autoGenerateTitle: false,
                            syncTitleToPlaud: false,
                            autoSummarize: false,
                            transcriptionQuality: "balanced",
                            defaultTranscriptionLanguage: "cs",
                        },
                    ]),
                }),
            }),
        });

    const tx = {
        select: vi
            .fn()
            .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                    innerJoin: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            for: vi.fn().mockReturnValue({
                                limit: vi
                                    .fn()
                                    .mockResolvedValue([{ deletedAt: null }]),
                            }),
                        }),
                    }),
                }),
            })
            .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                    where: vi.fn().mockReturnValue({
                        limit: vi.fn().mockResolvedValue([]),
                    }),
                }),
            }),
        insert: vi.fn().mockReturnValue({
            values: vi.fn().mockResolvedValue(undefined),
        }),
        update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue(undefined),
            }),
        }),
    };
    (db.transaction as Mock).mockImplementation(
        async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    );
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

/** Submit -> one `done` poll -> transcript -> delete, in that order. */
function installBatchApi(): void {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit = {}) => {
            const method = init.method ?? "GET";
            if (method === "POST") return jsonResponse({ id: "job-xyz" }, 201);
            if (method === "DELETE") return jsonResponse({});
            if (url.includes("/transcript")) {
                return jsonResponse({
                    metadata: {
                        language_pack_info: { word_delimiter: " " },
                        transcription_config: { language: "cs" },
                    },
                    results: [
                        {
                            type: "word",
                            alternatives: [
                                { content: "transcript", language: "cs" },
                            ],
                        },
                        {
                            type: "word",
                            alternatives: [{ content: "from", language: "cs" }],
                        },
                        {
                            type: "word",
                            alternatives: [
                                { content: "speechmatics", language: "cs" },
                            ],
                        },
                    ],
                });
            }
            return jsonResponse({ job: { status: "done" } });
        }),
    );
}

function requests(): { url: string; method: string; init: RequestInit }[] {
    return vi.mocked(globalThis.fetch).mock.calls.map((call) => {
        const [url, init = {}] = call as [string, RequestInit];
        return { url, method: init.method ?? "GET", init };
    });
}

describe("Speechmatics credentials route to the Batch jobs API, not the OpenAI SDK", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        audioCreate.mockReset();
        chatCreate.mockReset();
        installBatchApi();
    });

    it("submits a job with the configured model and language", async () => {
        mockDbForCredential({
            provider: "Speechmatics",
            baseUrl: null,
            defaultModel: "enhanced",
        });

        const result = await transcribeRecording("user-sm", "rec-sm");

        expect(result.success).toBe(true);
        expect(result.text).toBe("transcript from speechmatics");
        expect(result.detectedLanguage).toBe("cs");
        expect(audioCreate).not.toHaveBeenCalled();
        expect(chatCreate).not.toHaveBeenCalled();

        const submit = requests().find((r) => r.method === "POST");
        expect(submit?.url).toBe("https://asr.api.speechmatics.com/v2/jobs");
        expect(submit?.init.headers).toEqual({
            Authorization: "Bearer sm_speechmatics",
        });
        const form = submit?.init.body as FormData;
        expect(JSON.parse(form.get("config") as string)).toEqual({
            type: "transcription",
            transcription_config: { model: "enhanced", language: "cs" },
        });
    });

    it("falls back to the preset default model when the credential has none", async () => {
        mockDbForCredential({
            provider: "Speechmatics",
            baseUrl: null,
            defaultModel: null,
        });

        await transcribeRecording("user-sm", "rec-sm");

        const submit = requests().find((r) => r.method === "POST");
        const form = submit?.init.body as FormData;
        expect(
            JSON.parse(form.get("config") as string).transcription_config.model,
        ).toBe("enhanced");
    });

    it("honours a regional base URL and the +diarize suffix", async () => {
        mockDbForCredential({
            provider: "Speechmatics",
            baseUrl: "https://eu2.asr.api.speechmatics.com",
            defaultModel: "enhanced+diarize",
        });

        await transcribeRecording("user-sm", "rec-sm");

        const all = requests();
        const submit = all.find((r) => r.method === "POST");
        expect(submit?.url).toBe(
            "https://eu2.asr.api.speechmatics.com/v2/jobs",
        );
        const config = JSON.parse(
            (submit?.init.body as FormData).get("config") as string,
        );
        expect(config.transcription_config).toEqual({
            model: "enhanced",
            language: "cs",
            diarization: "speaker",
        });

        expect(all.find((r) => r.url.includes("/transcript"))?.url).toBe(
            "https://eu2.asr.api.speechmatics.com/v2/jobs/job-xyz/transcript?format=json-v2",
        );
    });

    it("sends the Almanac's names as the custom dictionary", async () => {
        vi.mocked(almanacTermsFor).mockResolvedValueOnce([
            { text: "Zefira", soundsLike: ["Zefyra"] },
            { text: "Blue Harbor", soundsLike: [] },
        ]);
        mockDbForCredential({
            provider: "Speechmatics",
            baseUrl: null,
            defaultModel: "enhanced",
        });

        await transcribeRecording("user-sm", "rec-sm");

        const submit = requests().find((r) => r.method === "POST");
        const config = JSON.parse(
            (submit?.init.body as FormData).get("config") as string,
        );
        expect(config.transcription_config.additional_vocab).toEqual([
            { content: "Zefira", sounds_like: ["Zefyra"] },
            { content: "Blue Harbor" },
        ]);
    });

    it("sends roster names once with the Almanac spelling in the provider request", async () => {
        vi.mocked(resolveMeetingRoster).mockResolvedValueOnce({
            eventId: "meeting",
            attendees: [
                { name: "jitka dvorakova", source: "calendar" },
                { name: "Míra Luvin", source: "meet" },
            ],
        });
        vi.mocked(almanacTermsFor).mockResolvedValueOnce([
            { text: "Jitka Dvořáková", soundsLike: ["Jituška"] },
            { text: "Zefira", soundsLike: [] },
        ]);
        mockDbForCredential({
            provider: "Speechmatics",
            baseUrl: null,
            defaultModel: "enhanced",
        });
        (db.select as Mock).mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([{ email: null }]),
                }),
            }),
        });

        const result = await transcribeRecording("user-sm", "rec-sm");

        expect(result.success).toBe(true);
        expect(resolveMeetingRoster).toHaveBeenCalledWith({
            ownerUserId: "user-sm",
            itemId: "rec-sm",
        });
        const submit = requests().find((r) => r.method === "POST");
        const config = JSON.parse(
            (submit?.init.body as FormData).get("config") as string,
        );
        expect(config.transcription_config.additional_vocab).toEqual([
            { content: "Jitka Dvořáková", sounds_like: ["Jituška"] },
            { content: "Míra Luvin" },
            { content: "Zefira" },
        ]);
    });

    it("does not look up the Almanac for Melia, which has no custom dictionary", async () => {
        mockDbForCredential({
            provider: "Speechmatics",
            baseUrl: null,
            defaultModel: "melia-1+diarize",
        });

        const result = await transcribeRecording("user-sm", "rec-sm");

        expect(result.success).toBe(true);
        expect(almanacTermsFor).not.toHaveBeenCalled();
        const submit = requests().find((r) => r.method === "POST");
        const config = JSON.parse(
            (submit?.init.body as FormData).get("config") as string,
        );
        expect(config.transcription_config).not.toHaveProperty(
            "additional_vocab",
        );
    });
});
