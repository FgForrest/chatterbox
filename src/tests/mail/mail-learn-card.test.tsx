// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailLearnCard } from "@/components/mail/mail-learn-card";
import type { MailDetail } from "@/lib/mail/detail";
import type {
    WorkflowWidgetFrame,
    WorkflowWidgetState,
} from "@/lib/pipeline/workflow-widgets";
import type { Recording } from "@/types/recording";

vi.mock("next-intl", () => ({
    useLocale: () => "en",
    useExtracted: () => (message: string, values?: Record<string, unknown>) => {
        const count = Number(values?.count ?? 0);
        if (
            message ===
            "{count, plural, one {# change applied} other {# changes applied}}"
        ) {
            return `${count} ${count === 1 ? "change" : "changes"} applied`;
        }
        if (
            message ===
            "Review finished: {count, plural, one {# change} other {# changes}} made"
        ) {
            return `Review finished: ${count} ${count === 1 ? "change" : "changes"} made`;
        }
        return message.replace(/\{(\w+)\}/g, (_match, key: string) =>
            String(values?.[key] ?? ""),
        );
    },
}));

vi.mock("sonner", () => ({
    toast: {
        error: vi.fn(),
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
    },
}));

vi.mock("@/components/help/help-button", () => ({
    HelpLink: ({ label }: { label: string }) => (
        <button type="button">{label}</button>
    ),
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

function stubFetch() {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (!init?.method) return Response.json(ready);
        if (init.method === "PATCH") {
            return Response.json({ version: 1 });
        }
        if (url.endsWith("/finish")) {
            return Response.json({
                status: "finished",
                applied: 2,
                skipped: [],
            });
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
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    await screen.findByRole("heading", { name: /Review what Learn found/ });
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
        expect(
            screen.getByRole("button", {
                name: "reviewing what Learn found",
            }),
        ).toBeTruthy();
        const rows = [
            screen.getByRole("checkbox", {
                name: "Add Eva to the Almanac",
            }),
            screen.getByRole("checkbox", {
                name: "Jan — leads — Orion",
            }),
        ];
        fireEvent.click(rows[0]);
        await waitFor(() =>
            expect((rows[0] as HTMLInputElement).checked).toBe(true),
        );

        fireEvent.click(
            screen.getByRole("checkbox", { name: "Tick all: New facts" }),
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
        expect(toast.success).toHaveBeenCalledWith(
            "Review finished: 2 changes made",
        );
    });
});

it("keeps a manually started mail Learn run inline", async () => {
    let reviewReads = 0;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") return Response.json({});
        reviewReads++;
        return Response.json(
            reviewReads === 1
                ? {
                      run: null,
                      available: true,
                      names: {},
                      types: {},
                      relations: {},
                      items: [],
                  }
                : {
                      run: { id: "run-2", status: "running" },
                      available: true,
                      names: {},
                      types: {},
                      relations: {},
                      items: [],
                  },
        );
    });
    vi.stubGlobal("fetch", fetch);
    render(
        <MailLearnCard
            mail={mail}
            detail={detail}
            canChange
            widget={widget("inline")}
            widgetId="mail-learn-running"
        />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Learn" }));

    expect(
        await screen.findByText(
            "Learn is reading the message with your Almanac.",
        ),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
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

it("hides Learn when the review endpoint says it is unavailable", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
            Response.json({
                ...ready,
                available: false,
                run: null,
                items: [],
            }),
        ),
    );

    const { container } = render(
        <MailLearnCard
            mail={mail}
            detail={detail}
            canChange
            widget={widget("inline")}
            widgetId="mail-learn-unavailable"
        />,
    );

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
});

it.each([
    [
        "AI_PROVIDER_NOT_CONFIGURED",
        "Learn needs a chat provider. Add one in Settings → Providers.",
    ],
    [
        "AI_PROVIDER_API_ERROR",
        "The provider's answer was not one Learn could use. Try again, or pick another model for Learn in Settings → Providers.",
    ],
    ["INTERNAL_ERROR", "Learn stopped on an error. Try again."],
])("shows the shared failure message for %s", async (errorCode, message) => {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
            Response.json({
                ...ready,
                run: { id: "run-failed", status: "failed", errorCode },
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
            widgetId={`mail-learn-failed-${errorCode}`}
        />,
    );

    expect(await screen.findByText(message)).toBeTruthy();
});

it.each([
    [[], "Nothing was applied"],
    [[{ ...ready.items[1], outcome: "applied" }], "1 change applied"],
])("describes finished results from their applied count", async (items, line) => {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
            Response.json({
                ...ready,
                run: { id: "run-finished", status: "finished" },
                items,
            }),
        ),
    );

    render(
        <MailLearnCard
            mail={mail}
            detail={detail}
            canChange
            widget={widget("inline")}
            widgetId="mail-learn-finished-count"
        />,
    );

    expect(await screen.findByText(line)).toBeTruthy();
});

it("edits mail new records through the shared new-record controls", async () => {
    const fetch = stubFetch();
    await renderReview("inline");

    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Eva Novak" } });
    fireEvent.blur(name);

    await waitFor(() =>
        expect(fetch).toHaveBeenCalledWith(
            "/api/recordings/mail-1/review/items/record-1",
            expect.objectContaining({
                method: "PATCH",
                body: JSON.stringify({
                    decision: "accepted",
                    version: 0,
                    choice: { name: "Eva Novak", typeKey: null },
                }),
            }),
        ),
    );
    expect(
        screen.getByRole("button", { name: "Never propose it" }),
    ).toBeTruthy();
    expect(
        screen.getByRole("button", { name: "It is someone known…" }),
    ).toBeTruthy();
});

it("renders every suggestion kind produced by mail Learn", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
            Response.json({
                ...ready,
                items: [
                    ready.items[0],
                    {
                        ...ready.items[1],
                        id: "known-1",
                        kind: "known_fact",
                        preTicked: true,
                    },
                    ready.items[1],
                    {
                        id: "phrase-1",
                        kind: "relation_phrase",
                        preTicked: false,
                        decision: null,
                        choice: null,
                        version: 0,
                        dependsOnLabel: null,
                        payload: {
                            phrase: "guides",
                            subject: { personId: "p-jan" },
                            object: { entityId: "e-orion" },
                            objectKind: "entity",
                            count: 1,
                            text: {
                                segmentIndex: 0,
                                charStart: 0,
                                charEnd: 16,
                            },
                            provenance: null,
                        },
                    },
                ],
            }),
        ),
    );
    render(
        <MailLearnCard
            mail={mail}
            detail={detail}
            canChange
            widget={widget("inline")}
            widgetId="mail-learn-kinds"
        />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));

    for (const title of [
        "New in the Almanac",
        "Known facts mentioned again",
        "New facts",
        "New kind of relation",
    ]) {
        expect(
            screen.getByRole("heading", { name: new RegExp(title) }),
        ).toBeTruthy();
    }
});

it("hides audio-only speakers and corrections from a mail review", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
            Response.json({
                ...ready,
                items: [
                    {
                        id: "speaker-1",
                        kind: "speaker",
                        preTicked: false,
                        decision: null,
                        choice: null,
                        version: 0,
                        dependsOnLabel: null,
                        payload: {
                            label: "speaker_1",
                            personId: "p-jan",
                            evidenceMs: [],
                            reason: "wrongly returned for mail",
                        },
                    },
                    {
                        id: "correction-1",
                        kind: "correction",
                        preTicked: false,
                        decision: null,
                        choice: null,
                        version: 0,
                        dependsOnLabel: null,
                        payload: {
                            kind: "correct",
                            heard: "Oryon",
                            target: { entityId: "e-orion" },
                            replacement: "Orion",
                            anchors: [
                                { turnIndex: 0, charStart: 10, charEnd: 15 },
                            ],
                        },
                    },
                    ready.items[1],
                ],
            }),
        ),
    );
    render(
        <MailLearnCard
            mail={mail}
            detail={detail}
            canChange
            widget={widget("inline")}
            widgetId="mail-learn-audio-only-kinds"
        />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    await screen.findByRole("heading", { name: /New facts/ });

    expect(screen.queryByRole("heading", { name: /Speakers/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Corrections/ })).toBeNull();
});

it("re-learns mail and can forget rejected suggestions", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") return Response.json({ forgotten: 1 });
        if (init?.method === "POST") return Response.json({ jobId: null });
        return Response.json({
            ...ready,
            run: { id: "run-finished", status: "finished" },
            items: [{ ...ready.items[1], outcome: "rejected" }],
        });
    });
    vi.stubGlobal("fetch", fetch);
    render(
        <MailLearnCard
            mail={mail}
            detail={detail}
            canChange
            widget={widget("inline")}
            widgetId="mail-learn-relearn"
        />,
    );

    fireEvent.click(
        await screen.findByRole("button", { name: "View results" }),
    );
    fireEvent.click(
        await screen.findByRole("checkbox", {
            name: "Re-learn: also propose again what I rejected on this message",
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Re-learn" }));

    await waitFor(() =>
        expect(fetch).toHaveBeenCalledWith(
            "/api/recordings/mail-1/review/dismissals",
            { method: "DELETE" },
        ),
    );
    expect(fetch).toHaveBeenCalledWith("/api/recordings/mail-1/learn", {
        method: "POST",
    });
});
