import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), nudge: vi.fn() }));
vi.mock("@/db", () => ({ db: {}, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "suggestion-locale-test",
        AUTHZ_MODE: "local",
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
    },
}));
vi.mock("@/db/queries/async-jobs", () => ({ enqueueJob: mocks.enqueue }));
vi.mock("@/lib/meetings/suggestions-provider", () => ({
    agendaSuggestionsProvider: async () => ({
        access: { agenda: { id: "agenda" } },
    }),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: mocks.nudge }));

import {
    agendaSuggestionsJobHandler,
    enqueueAgendaSuggestions,
} from "@/lib/meetings/suggestions-job";

beforeEach(() => {
    mocks.enqueue
        .mockReset()
        .mockResolvedValue({ created: true, job: { id: "job" } });
    mocks.nudge.mockReset();
});
it("persists the request's resolved Czech UI locale in durable work", async () => {
    await enqueueAgendaSuggestions("viewer", "agenda", "cs-CZ");
    expect(mocks.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
            userId: "viewer",
            payload: { agendaId: "agenda", uiLocale: "cs-CZ" },
        }),
    );
    expect(
        agendaSuggestionsJobHandler.parsePayload({
            agendaId: "agenda",
            uiLocale: "cs-CZ",
        }),
    ).toEqual({ agendaId: "agenda", uiLocale: "cs-CZ" });
});
it("still parses already queued jobs without a locale and ignores malformed locales", () => {
    expect(
        agendaSuggestionsJobHandler.parsePayload({ agendaId: "agenda" }),
    ).toEqual({ agendaId: "agenda", uiLocale: undefined });
    expect(
        agendaSuggestionsJobHandler.parsePayload({
            agendaId: "agenda",
            uiLocale: 23,
        }),
    ).toEqual({ agendaId: "agenda", uiLocale: undefined });
});
