import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithoutIdleTimeout } from "@/lib/ai/provider-fetch";
import { recordAiUsage } from "@/lib/ai/usage-cost";
import { reserveMynah } from "@/lib/hosted/billing/enforcement";
import { resolveMeetingRoster } from "@/lib/integrations/google/meeting-roster";
import { transcribeRecording } from "@/lib/transcription/transcribe-recording";
import { resolvedAudioProfile } from "@/tests/profiles/seeded-profile-fixture";

const mocks = vi.hoisted(() => ({
    select: vi.fn(),
    managed: false,
    provider: "Speechmatics",
    model: "enhanced",
    signedUrl: "https://example.com/audio",
    transport: vi.fn(),
}));
vi.mock("@/db", () => ({ db: { select: mocks.select }, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: true,
        MYNAH_BASE_URL: "https://example.com",
        MYNAH_SERVICE_TOKEN: "test",
        WHISPER_REQUEST_TIMEOUT_MS: 60_000,
    },
}));
vi.mock("@/lib/ai/provider-fetch", () => ({
    providerFetch: mocks.transport,
    fetchWithoutIdleTimeout: mocks.transport,
}));
vi.mock("@/lib/ai/usage-cost", () => ({ recordAiUsage: vi.fn() }));
vi.mock("@/lib/hosted/billing/enforcement", () => ({
    reserveMynah: vi.fn(async () => ({
        reserved: true,
        userId: "actor",
        seconds: 60,
    })),
    commitMynahReservation: vi.fn(),
    releaseMynahReservation: vi.fn(),
}));
vi.mock("@/lib/sharing/run-context", () => ({
    resolveRunContext: vi.fn(async () => ({
        view: "private",
        ownerUserId: "actor",
        contentUserId: "actor",
        actorUserId: "actor",
        settingsUserId: "actor",
    })),
}));
vi.mock("@/lib/sharing/writer", () => ({
    contentWriterRefusalNow: vi.fn(async () => null),
}));
vi.mock("@/lib/entitlements", () => ({
    isHostedLockedOut: vi.fn(async () => false),
}));
vi.mock("@/lib/profiles/resolve-manual", () => ({
    resolveManualItemProfile: vi.fn(async () => resolvedAudioProfile()),
}));
vi.mock("@/lib/profiles/providers", () => ({
    resolveStepProvider: vi.fn(async () => ({
        kind: mocks.managed ? "managed" : "credential",
        payerUserId: "actor",
        organizationCredential: false,
        reserveCall: async () => undefined,
        actorSettings: {},
        credential: mocks.managed
            ? null
            : {
                  id: "card",
                  apiKey: "test",
                  provider: mocks.provider,
                  defaultModel: mocks.model,
              },
    })),
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn(async () => ({
        downloadFile: async () => Buffer.from("audio"),
        getSignedUrl: async () => mocks.signedUrl,
    })),
}));
vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (s: string) => s,
    decryptJsonField: (value: unknown) => value,
}));
vi.mock("@/lib/integrations/google/meeting-roster", () => ({
    resolveMeetingRoster: vi.fn(async () => null),
}));
vi.mock("@/lib/transcription/persist", () => ({
    upsertTranscription: vi.fn(async () => ({ committed: true })),
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn(),
    removeRecordingSidecar: vi.fn(),
}));
vi.mock("@/lib/sharing/notify", () => ({ notifyIfShared: vi.fn() }));
vi.mock("@/lib/webhooks/emit", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));

function rows(value: unknown[]) {
    const query = {
        from: vi.fn(),
        innerJoin: vi.fn(),
        where: vi.fn(),
        limit: vi.fn(async () => value),
    };
    query.from.mockReturnValue(query);
    query.innerJoin.mockReturnValue(query);
    query.where.mockReturnValue(query);
    return query;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.managed = false;
    mocks.provider = "Speechmatics";
    mocks.model = "enhanced";
    mocks.signedUrl = "https://example.com/audio";
    mocks.transport.mockReset();
    mocks.select.mockReset();
    mocks.select
        .mockReturnValueOnce(
            rows([
                {
                    id: "item",
                    userId: "actor",
                    title: "Example",
                    storagePath: "audio.mp3",
                    duration: 60_000,
                },
            ]),
        )
        .mockReturnValueOnce(rows([]));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("transcription usage boundaries", () => {
    it("does not record an Almanac preparation failure before Speechmatics is called", async () => {
        vi.mocked(resolveMeetingRoster).mockRejectedValueOnce(
            new Error("Almanac unavailable"),
        );
        const result = await transcribeRecording("actor", "item");
        expect(result).toMatchObject({
            success: false,
            error: "Almanac unavailable",
        });
        expect(mocks.transport).not.toHaveBeenCalled();
        expect(recordAiUsage).not.toHaveBeenCalled();
    });

    it("does not record Gemini model validation as a provider attempt", async () => {
        mocks.provider = "Google Gemini";
        mocks.model = "../invalid";
        const result = await transcribeRecording("actor", "item");
        expect(result.success).toBe(false);
        expect(result.error).toContain("not a Google Gemini model id");
        expect(mocks.transport).not.toHaveBeenCalled();
        expect(recordAiUsage).not.toHaveBeenCalled();
    });

    it.each([
        true,
        false,
    ])("records every Mynah retry without duplicating the final outcome (success=%s)", async (success) => {
        vi.useFakeTimers();
        mocks.managed = true;
        mocks.transport.mockImplementation(async () =>
            Response.json({ error: "unavailable" }, { status: 503 }),
        );
        if (success)
            mocks.transport
                .mockResolvedValueOnce(Response.json({}, { status: 503 }))
                .mockResolvedValueOnce(Response.json({}, { status: 502 }))
                .mockResolvedValueOnce(
                    Response.json({ text: "Transcript", language: "en" }),
                );
        const pending = transcribeRecording("actor", "item");
        await vi.runAllTimersAsync();
        const result = await pending;
        expect(result.success).toBe(success);
        expect(fetchWithoutIdleTimeout).toHaveBeenCalledTimes(3);
        expect(recordAiUsage).toHaveBeenCalledTimes(3);
        const values = vi
            .mocked(recordAiUsage)
            .mock.calls.map(([, value]) => value);
        expect(values.map((value) => value.outcome ?? "succeeded")).toEqual(
            success
                ? ["failed", "failed", "succeeded"]
                : ["failed", "failed", "failed"],
        );
        for (const [context] of vi.mocked(recordAiUsage).mock.calls)
            expect(context).toMatchObject({
                provider: "Mynah",
                model: "parakeet",
                payerUserId: "actor",
                ownerUserId: "actor",
            });
    });

    it.each([
        "budget",
        "storage",
    ])("records no Mynah attempt for a %s refusal", async (reason) => {
        mocks.managed = true;
        if (reason === "budget")
            vi.mocked(reserveMynah).mockResolvedValueOnce({
                reserved: false,
                userId: "actor",
                seconds: 60,
            });
        else mocks.signedUrl = "/api/audio";
        expect((await transcribeRecording("actor", "item")).success).toBe(
            false,
        );
        expect(mocks.transport).not.toHaveBeenCalled();
        expect(recordAiUsage).not.toHaveBeenCalled();
    });
});
