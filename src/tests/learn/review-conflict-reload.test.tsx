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
import type { WorkflowWidgetFrame } from "@/lib/pipeline/workflow-widgets";

vi.mock("sonner", () => ({
    toast: {
        error: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
        info: vi.fn(),
    },
}));

const item = {
    id: "fact-1",
    kind: "fact",
    preTicked: false,
    decision: null,
    choice: null,
    version: 0,
    dependsOnLabel: null,
    payload: {
        subject: { personId: "person-1" },
        relationKey: "leads",
        object: { entityId: "entity-1" },
        startMs: 0,
        endMs: 1_000,
        speakerLabel: null,
    },
};

const ready = {
    run: { id: "run-1", status: "ready" },
    available: true,
    names: { "person-1": "Jan", "entity-1": "Orion" },
    types: {},
    relations: { leads: "leads" },
    items: [item],
};

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe.each([
    "inline",
    "dialog",
] as const)("recording Learn conflict recovery in the %s frame", (frame: WorkflowWidgetFrame) => {
    it("finishes with versions reloaded after a decision conflict", async () => {
        let reviewLoads = 0;
        const fetch = vi.fn(async (url: string, init?: RequestInit) => {
            if (!init?.method) {
                reviewLoads += 1;
                const body =
                    reviewLoads === 1
                        ? ready
                        : {
                              ...ready,
                              items: [{ ...item, version: 9 }],
                          };
                return Response.json(body);
            }
            if (init.method === "PATCH") {
                return new Response("{}", { status: 409 });
            }
            if (url.endsWith("/finish?source=riffado")) {
                return Response.json({
                    status: "finished",
                    applied: 0,
                    dismissed: 1,
                    skipped: [],
                });
            }
            return new Response("{}", { status: 404 });
        });
        vi.stubGlobal("fetch", fetch);

        render(
            <LearnReview
                recordingId="rec-1"
                source="riffado"
                turns={[]}
                frame={frame}
                showTrigger={false}
            />,
        );
        if (frame === "dialog") {
            fireEvent.click(
                await screen.findByRole("button", { name: "Review" }),
            );
        }
        await screen.findByRole("heading", {
            name: /Review what Learn found/,
        });

        fireEvent.click(
            screen.getByRole("checkbox", { name: "Jan — leads — Orion" }),
        );
        await waitFor(() => expect(reviewLoads).toBe(2));

        fireEvent.click(screen.getByRole("button", { name: "Finish review" }));
        await waitFor(() => {
            const finishCall = fetch.mock.calls.find(([url]) =>
                String(url).endsWith("/finish?source=riffado"),
            );
            expect(finishCall?.[1]?.body).toBe(
                JSON.stringify({ versions: { "fact-1": 9 } }),
            );
        });
    });
});
