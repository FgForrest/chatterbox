// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearnWidget } from "@/components/learn/learn-widget";

vi.mock("sonner", () => ({
    toast: {
        error: vi.fn(),
        dismiss: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
        info: vi.fn(),
    },
}));

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe.each([
    { kind: "audio", frame: "inline" },
    { kind: "audio", frame: "dialog" },
    { kind: "mail", frame: "inline" },
    { kind: "mail", frame: "dialog" },
] as const)("older known-only $kind review in the $frame frame", ({
    kind,
    frame,
}) => {
    it("uses a sticky footer only for the inline review", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({
                    run: { id: "older-run", status: "ready" },
                    available: true,
                    items: [],
                    names: {},
                    types: {},
                    relations: {},
                }),
            ),
        );
        render(
            <LearnWidget
                kind={kind}
                frame={frame}
                recordingId="older-item"
                showTrigger={false}
                initialOpen
            />,
        );
        await screen.findByRole("heading", { name: "Review what Learn found" });
        const footer = screen.getByRole("contentinfo");
        expect(footer.classList.contains("sticky")).toBe(frame === "inline");
        const body = document.querySelector("[data-widget-body]");
        expect(body?.classList.contains("overflow-x-clip")).toBe(
            frame === "inline",
        );
        expect(body?.classList.contains("overflow-y-auto")).toBe(
            frame === "dialog",
        );
    });

    it("finishes directly from the collapsed card without claiming suggestions wait", async () => {
        let finished = false;
        const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
            if (init?.method === "POST") {
                finished = true;
                return Response.json({
                    status: "finished",
                    applied: 1,
                    skipped: [],
                });
            }
            return Response.json({
                run: {
                    id: "older-run",
                    status: finished ? "finished" : "ready",
                },
                available: true,
                items: [],
                names: {},
                types: {},
                relations: {},
                known: { people: 1, things: 1 },
            });
        });
        vi.stubGlobal("fetch", fetch);
        const onFinished = vi.fn();
        render(
            <LearnWidget
                kind={kind}
                frame={frame}
                recordingId="older-item"
                showTrigger={false}
                collapseReady
                onFinished={onFinished}
            />,
        );
        const finish = await screen.findByRole("button", {
            name: "Finish review",
        });
        expect(
            screen.queryByText(/suggestions? waits? for your review/),
        ).toBeNull();
        fireEvent.click(finish);
        await waitFor(() => expect(onFinished).toHaveBeenCalledOnce());
        const requests = fetch.mock.calls.filter(
            ([, init]) => init?.method === "POST",
        );
        expect(requests).toHaveLength(1);
        expect(JSON.parse(String(requests[0][1]?.body))).toEqual({
            versions: {},
        });
        expect(
            screen.queryByRole("button", { name: "Finish review" }),
        ).toBeNull();
    });
});
