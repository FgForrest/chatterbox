// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearnReview } from "@/components/learn/learn-review";

vi.mock("sonner", () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const TURNS = [
    { speaker: "speaker_0", startMs: 0, endMs: 5_000, text: "Máme tu Tavesy." },
    { speaker: "speaker_1", startMs: 5_000, endMs: 9_000, text: "Vedu Orion." },
];

const READY = {
    run: { id: "run-1", status: "ready" },
    available: true,
    names: { "e-tavesi": "Tavesi", "e-orion": "Orion", "p-jan": "Jan" },
    types: {
        "e-tavesi": "organization",
        "e-orion": "project",
        "p-jan": "person",
    },
    relations: { leads: "leads" },
    items: [
        {
            id: "i-correction",
            kind: "correction",
            preTicked: true,
            decision: null,
            choice: null,
            version: 0,
            dependsOnLabel: null,
            payload: {
                kind: "correct",
                heard: "Tavesy",
                target: { entityId: "e-tavesi" },
                replacement: "Tavesi",
                anchors: [{ turnIndex: 0, charStart: 8, charEnd: 14 }],
            },
        },
        {
            id: "i-fact",
            kind: "fact",
            preTicked: false,
            decision: null,
            choice: null,
            version: 0,
            dependsOnLabel: null,
            payload: {
                subject: { personId: "p-jan" },
                relationKey: "leads",
                object: { entityId: "e-orion" },
                startMs: 5_000,
                endMs: 9_000,
                speakerLabel: null,
            },
        },
    ],
};

function respond(routes: Record<string, unknown>) {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        const key = `${init?.method ?? "GET"} ${url}`;
        const body = routes[key];
        if (body === undefined) return new Response("{}", { status: 404 });
        return Response.json(body);
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
}

describe("LearnReview", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("offers nothing where Learn is not available", async () => {
        const fetch = respond({
            "GET /api/recordings/rec-1/review": {
                run: null,
                items: [],
                names: {},
                types: {},
                relations: {},
                available: false,
            },
        });
        render(
            <LearnReview recordingId="rec-1" source="riffado" turns={TURNS} />,
        );
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        expect(screen.queryByRole("button", { name: /Learn/ })).toBeNull();
    });

    it("opens the review with its two defaults, keeps a decision, and finishes with the versions shown", async () => {
        const fetch = respond({
            "GET /api/recordings/rec-1/review?view=org": READY,
            "PATCH /api/recordings/rec-1/review/items/i-fact?view=org": {
                version: 1,
            },
            "POST /api/recordings/rec-1/review/finish?view=org": {
                status: "finished",
                applied: 2,
                dismissed: 0,
                skipped: [],
            },
        });
        const onFinished = vi.fn();
        render(
            <LearnReview
                recordingId="rec-1"
                view="org"
                source="riffado"
                turns={TURNS}
                onFinished={onFinished}
            />,
        );
        fireEvent.click(
            await screen.findByRole("button", { name: /Review \(2\)/ }),
        );

        const correction = screen.getByRole("checkbox", {
            name: "Correct Tavesy",
        }) as HTMLInputElement;
        const fact = screen.getByRole("checkbox", {
            name: "Jan — leads — Orion",
        }) as HTMLInputElement;
        expect(correction.checked).toBe(true);
        expect(fact.checked).toBe(false);

        fireEvent.click(fact);
        await waitFor(() =>
            expect(fetch).toHaveBeenCalledWith(
                "/api/recordings/rec-1/review/items/i-fact?view=org",
                expect.objectContaining({
                    method: "PATCH",
                    body: JSON.stringify({
                        decision: "accepted",
                        version: 0,
                        choice: null,
                    }),
                }),
            ),
        );
        await waitFor(() => expect(fact.checked).toBe(true));

        fireEvent.click(screen.getByRole("button", { name: "Finish review" }));
        await waitFor(() => expect(onFinished).toHaveBeenCalled());
        expect(fetch).toHaveBeenCalledWith(
            "/api/recordings/rec-1/review/finish?view=org",
            expect.objectContaining({
                body: JSON.stringify({
                    versions: { "i-correction": 0, "i-fact": 1 },
                }),
            }),
        );
    });
});
