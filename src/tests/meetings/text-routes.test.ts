import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    get: vi.fn(),
    update: vi.fn(),
    gate: vi.fn(),
    session: vi.fn(),
}));
vi.mock("@/lib/meetings/text-documents", () => ({
    getAgendaText: mocks.get,
    updateAgendaText: mocks.update,
}));
vi.mock("@/lib/auth-server", () => ({ requireApiSession: mocks.session }));
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: mocks.gate,
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

import * as web from "@/app/api/meetings/[id]/text/route";
import * as recorder from "@/app/api/v1/recorder/agendas/[id]/text/route";

beforeEach(() => {
    vi.clearAllMocks();
    mocks.gate.mockResolvedValue({ authn: { user: { id: "viewer" } } });
    mocks.session.mockResolvedValue({ user: { id: "viewer" } });
    mocks.get.mockResolvedValue({
        field: "point:p:note",
        update: "AAA=",
        stateVector: "AA==",
        version: 0,
    });
    mocks.update.mockResolvedValue({
        field: "point:p:note",
        update: "AAA=",
        stateVector: "AA==",
        version: 1,
    });
});
describe.each([web, recorder])("agenda text HTTP protocol", (route) => {
    const context = { params: Promise.resolve({ id: "agenda" }) };
    it("fetches the authoritative field state for the authenticated principal", async () => {
        const response = await route.GET(
            new Request("https://example.com/text?field=point%3Ap%3Anote"),
            context,
        );
        expect(response.status).toBe(200);
        expect(mocks.get).toHaveBeenCalledWith(
            "viewer",
            "agenda",
            "point:p:note",
        );
        expect((await response.json()).version).toBe(0);
    });
    it("passes the bounded update and optional vector without trusting a body principal", async () => {
        const response = await route.POST(
            new Request("https://example.com/text", {
                method: "POST",
                body: JSON.stringify({
                    field: "point:p:note",
                    update: "AAA=",
                    stateVector: "AA==",
                    userId: "other",
                }),
            }),
            context,
        );
        expect(response.status).toBe(200);
        expect(mocks.update).toHaveBeenCalledWith("viewer", "agenda", {
            field: "point:p:note",
            update: "AAA=",
            stateVector: "AA==",
        });
    });
    it("bounds a streamed request even without Content-Length", async () => {
        const response = await route.POST(
            new Request("https://example.com/text", {
                method: "POST",
                body: "x".repeat(100001),
            }),
            context,
        );
        expect(response.status).toBe(413);
        expect(mocks.update).not.toHaveBeenCalled();
    });
    it.each([
        "not JSON",
        JSON.stringify({ field: "point:p:note" }),
        JSON.stringify({ field: "point:p:note", update: "x".repeat(90000) }),
    ])("refuses malformed or oversized input", async (body) => {
        const response = await route.POST(
            new Request("https://example.com/text", { method: "POST", body }),
            context,
        );
        expect(response.status).toBe(400);
        expect(mocks.update).not.toHaveBeenCalled();
    });
});
