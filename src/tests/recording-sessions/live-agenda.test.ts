import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    gate: vi.fn(),
    set: vi.fn(),
    chunks: vi.fn(),
    serialize: vi.fn((value: unknown, _chunks: unknown) => value),
}));
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: mocks.gate,
}));
vi.mock("@/lib/recording-sessions/store", () => ({
    setRecordingSessionAgenda: mocks.set,
    listRecordingSessionChunks: mocks.chunks,
}));
vi.mock("@/lib/recording-sessions/serialize", () => ({
    serializeRecordingSession: mocks.serialize,
}));
vi.mock("@/lib/pipeline/state", () => ({}));
vi.mock("@/lib/storage/factory", () => ({}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

import { PATCH } from "@/app/api/v1/recording-sessions/[id]/route";
import {
    parseCreateRecordingSessionBody,
    parseSessionAgendaBody,
    readRecordingSessionMetadata,
} from "@/lib/recording-sessions/metadata";

beforeEach(() => {
    vi.clearAllMocks();
    mocks.gate.mockResolvedValue({
        authn: { user: { id: "viewer" }, apiKeyId: "key" },
    });
    mocks.set.mockResolvedValue({
        id: "session",
        metadata: { liveAgendaId: "agenda", agendaId: null },
    });
    mocks.chunks.mockResolvedValue([{ index: 2, size: 128 }]);
});

describe("live session agenda metadata", () => {
    it("adds only the new metadata key at creation and preserves completion semantics", () => {
        const base = {
            clientRecordingId: "12345678-1234-1234-1234-123456789abc",
            mimeType: "audio/webm",
            channelLayout: ["system"],
            startedAt: "2026-11-08T10:00:00Z",
        };
        expect(
            parseCreateRecordingSessionBody(base).metadata,
        ).not.toHaveProperty("liveAgendaId");
        expect(
            parseCreateRecordingSessionBody({ ...base, agendaId: "agenda" })
                .metadata,
        ).toEqual({ channelLayout: ["system"], liveAgendaId: "agenda" });
        expect(
            readRecordingSessionMetadata({
                channelLayout: [],
                liveAgendaId: "agenda",
                agendaId: null,
            }),
        ).toMatchObject({ liveAgendaId: "agenda", agendaId: null });
    });
    it.each([
        {},
        null,
        { agendaId: "" },
        { agendaId: " " },
        { agendaId: 1 },
        { agendaId: "x".repeat(256) },
    ])("rejects a malformed explicit choice", (body) => {
        expect(() => parseSessionAgendaBody(body)).toThrow();
    });
    it.each([
        "agenda",
        null,
    ])("accepts an explicit choice without changing agendaId on completion", async (agendaId) => {
        const response = await PATCH(
            new Request(
                "https://example.com/api/v1/recording-sessions/session",
                { method: "PATCH", body: JSON.stringify({ agendaId }) },
            ),
            { params: Promise.resolve({ id: "session" }) },
        );
        expect(response.status).toBe(200);
        expect(mocks.set).toHaveBeenCalledWith({
            userId: "viewer",
            apiKeyId: "key",
            sessionId: "session",
            agendaId,
        });
        expect((await response.json()).metadata.agendaId).toBeNull();
        expect(mocks.chunks).toHaveBeenCalledWith("session");
        expect(mocks.serialize).toHaveBeenCalledWith(
            expect.objectContaining({ id: "session" }),
            [{ index: 2, size: 128 }],
        );
    });
    it("authenticates before parsing and never accepts the principal from the body", async () => {
        mocks.gate.mockResolvedValue({
            response: Response.json({}, { status: 401 }),
        });
        const response = await PATCH(
            new Request("https://example.com/session", {
                method: "PATCH",
                body: "invalid",
            }),
            { params: Promise.resolve({ id: "session" }) },
        );
        expect(response.status).toBe(401);
        expect(mocks.set).not.toHaveBeenCalled();
    });
});
