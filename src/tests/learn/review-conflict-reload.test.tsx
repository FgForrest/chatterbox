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
import { MailLearnCard } from "@/components/mail/mail-learn-card";
import type { MailDetail } from "@/lib/mail/detail";
import type {
    WorkflowWidgetFrame,
    WorkflowWidgetState,
} from "@/lib/pipeline/workflow-widgets";
import type { Recording } from "@/types/recording";

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
        text: { segmentIndex: 0, charStart: 0, charEnd: 16 },
        provenance: null,
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

const mail = {
    id: "mail-1",
    filename: "Project update",
    duration: 0,
    filesize: 512,
    startTime: "2026-10-16T10:00:00.000Z",
    deviceSn: "mail",
    kind: "mail",
} satisfies Recording;

const detail = {
    unreadable: false,
    participants: [],
    segments: [
        {
            index: 0,
            role: "body",
            depth: 0,
            text: "Jan leads Orion.",
            participantRef: null,
            at: null,
        },
    ],
} as unknown as MailDetail;

type Variant = "recording" | "mail";

function widget(frame: WorkflowWidgetFrame): WorkflowWidgetState {
    return {
        visible: true,
        active: true,
        collapsed: false,
        frame,
        tone: "review",
        action: "review",
    };
}

async function renderReview(variant: Variant, frame: WorkflowWidgetFrame) {
    if (variant === "recording") {
        render(
            <LearnReview
                recordingId="rec-1"
                source="riffado"
                turns={[]}
                frame={frame}
                showTrigger={false}
            />,
        );
    } else {
        render(
            <MailLearnCard
                mail={mail}
                detail={detail}
                canChange
                widget={widget(frame)}
                widgetId={`mail-learn-${frame}`}
            />,
        );
    }
    if (frame === "dialog" || variant === "mail") {
        fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    }
    await screen.findByRole("heading", { name: /Review what Learn found/ });
}

function finishUrl(variant: Variant): string {
    if (variant === "recording") {
        return "/api/recordings/rec-1/review/finish?source=riffado";
    }
    return "/api/recordings/mail-1/review/finish";
}

function suggestionCheckbox(): HTMLElement {
    return screen.getByRole("checkbox", { name: "Jan — leads — Orion" });
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe.each([
    { variant: "recording", frame: "inline" },
    { variant: "recording", frame: "dialog" },
    { variant: "mail", frame: "inline" },
    { variant: "mail", frame: "dialog" },
] as const)("$variant Learn conflict recovery in the $frame frame", ({
    variant,
    frame,
}) => {
    it("finishes with versions reloaded after a decision conflict", async () => {
        let reviewLoads = 0;
        const fetch = vi.fn(async (url: string, init?: RequestInit) => {
            if (!init?.method) {
                reviewLoads += 1;
                const body =
                    reviewLoads === 1
                        ? ready
                        : { ...ready, items: [{ ...item, version: 9 }] };
                return Response.json(body);
            }
            if (init.method === "PATCH") {
                return new Response("{}", { status: 409 });
            }
            if (url === finishUrl(variant)) {
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
        await renderReview(variant, frame);

        fireEvent.click(suggestionCheckbox());
        await waitFor(() => expect(reviewLoads).toBe(2));

        fireEvent.click(screen.getByRole("button", { name: "Finish review" }));
        await waitFor(() => {
            const finishCall = fetch.mock.calls.find(
                ([url]) => String(url) === finishUrl(variant),
            );
            expect(finishCall?.[1]?.body).toBe(
                JSON.stringify({ versions: { "fact-1": 9 } }),
            );
        });
    });

    it("reloads after a finish conflict and retries with fresh versions", async () => {
        let reviewLoads = 0;
        let finishAttempts = 0;
        const fetch = vi.fn(async (url: string, init?: RequestInit) => {
            if (!init?.method) {
                reviewLoads += 1;
                const body =
                    reviewLoads === 1
                        ? ready
                        : { ...ready, items: [{ ...item, version: 9 }] };
                return Response.json(body);
            }
            if (url === finishUrl(variant)) {
                finishAttempts += 1;
                if (finishAttempts === 1) {
                    return new Response("{}", { status: 409 });
                }
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
        await renderReview(variant, frame);

        const finish = screen.getByRole("button", { name: "Finish review" });
        fireEvent.click(finish);
        await waitFor(() => expect(reviewLoads).toBe(2));
        await waitFor(() =>
            expect((finish as HTMLButtonElement).disabled).toBe(false),
        );

        fireEvent.click(finish);
        await waitFor(() => expect(finishAttempts).toBe(2));
        const finishCalls = fetch.mock.calls.filter(
            ([url]) => String(url) === finishUrl(variant),
        );
        expect(finishCalls[1]?.[1]?.body).toBe(
            JSON.stringify({ versions: { "fact-1": 9 } }),
        );
    });
});
