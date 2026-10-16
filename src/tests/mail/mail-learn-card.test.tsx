// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailLearnCard } from "@/components/mail/mail-learn-card";
import type { MailDetail } from "@/lib/mail/detail";
import type {
    WorkflowWidgetFrame,
    WorkflowWidgetState,
} from "@/lib/pipeline/workflow-widgets";
import type { Recording } from "@/types/recording";

vi.mock("next-intl", () => ({
    useExtracted: () => (message: string) => message,
}));

vi.mock("sonner", () => ({
    toast: { error: vi.fn(), success: vi.fn() },
}));

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

const ready = {
    run: { id: "run-1", status: "ready" },
    available: true,
    names: { "p-jan": "Jan", "e-orion": "Orion" },
    types: {},
    relations: { leads: "leads" },
    items: [
        {
            id: "record-1",
            kind: "new_record",
            preTicked: false,
            decision: null,
            choice: null,
            version: 0,
            dependsOnLabel: null,
            payload: {
                ref: "new-1",
                kind: "person",
                name: "Eva",
                address: "eva@example.com",
                evidence: [],
            },
        },
        {
            id: "fact-1",
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
                text: { segmentIndex: 0, charStart: 0, charEnd: 16 },
                provenance: null,
            },
        },
    ],
};

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

function stubFetch(patchOk = true) {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (!init?.method) return Response.json(ready);
        if (init.method === "PATCH") {
            if (!patchOk) return new Response("{}", { status: 409 });
            return Response.json({ version: 1 });
        }
        if (url.endsWith("/finish")) {
            return Response.json({ applied: 2 });
        }
        return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
}

async function renderReview(frame: WorkflowWidgetFrame) {
    render(
        <MailLearnCard
            mail={mail}
            detail={detail}
            canChange
            widget={widget(frame)}
            widgetId={`mail-learn-${frame}`}
        />,
    );
    if (frame === "dialog") {
        fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    }
    await screen.findByRole("heading", { name: "Review what Learn found" });
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe.each([
    "inline",
    "dialog",
] as const)("mail Learn behavior in the %s frame", (frame) => {
    it("ticks rows, toggles the group, and finishes", async () => {
        const fetch = stubFetch();
        await renderReview(frame);

        expect(
            document.querySelector('[data-shared-learn-row="new_record"]'),
        ).toBeTruthy();
        const rows = screen.getAllByRole("checkbox", { name: "Apply this" });
        fireEvent.click(rows[0]);
        await waitFor(() =>
            expect((rows[0] as HTMLInputElement).checked).toBe(true),
        );

        fireEvent.click(
            screen.getByRole("checkbox", { name: "Apply all suggestions" }),
        );
        await waitFor(() =>
            expect((rows[1] as HTMLInputElement).checked).toBe(true),
        );

        fireEvent.click(screen.getByRole("button", { name: "Finish review" }));
        await waitFor(() =>
            expect(fetch).toHaveBeenCalledWith(
                "/api/recordings/mail-1/review/finish",
                expect.objectContaining({ method: "POST" }),
            ),
        );
    });

    it("rolls a tick back when saving fails", async () => {
        stubFetch(false);
        await renderReview(frame);
        const row = screen.getAllByRole("checkbox", { name: "Apply this" })[0];
        fireEvent.click(row);
        await waitFor(() =>
            expect((row as HTMLInputElement).checked).toBe(false),
        );
    });
});

it("shows the Learn icon on its collapsed result line", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
            Response.json({
                ...ready,
                run: { id: "run-1", status: "finished" },
                items: [],
            }),
        ),
    );

    render(
        <MailLearnCard
            mail={mail}
            detail={detail}
            canChange
            widget={widget("inline")}
            widgetId="mail-learn-finished"
        />,
    );

    const title = await screen.findByText("Learn complete");
    expect(
        title
            .closest("[data-workflow-widget-line]")
            ?.querySelector(".lucide-graduation-cap"),
    ).toBeTruthy();
});
