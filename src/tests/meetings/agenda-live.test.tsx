// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    renderHook,
    screen,
    waitFor,
} from "@testing-library/react";
import type { TranslationValues } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { OutlineEditor } from "@/components/meetings/outline-editor";
import { useAgenda } from "@/components/meetings/use-agenda";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import {
    AGENDA_TEXT_NAME,
    agendaTextBase64,
    agendaTextBytes,
    createAgendaTextDoc,
} from "@/lib/meetings/text-model";
import { detail, point } from "./ui-fixtures";

vi.mock("next-intl", () => ({
    useExtracted: () => (text: string, values?: TranslationValues) =>
        translatedSourceMessage("en", text, values),
    useFormatter: () => ({
        dateTime: (value: Date) => value.toISOString().slice(11, 16),
    }),
}));
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("web agenda live updates", () => {
    it("uses the materialized point version when indenting immediately after a collaborative save", async () => {
        const doc = createAgendaTextDoc("Planning");
        let version = 3;
        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
            if (init?.method === "POST") {
                const body = JSON.parse(String(init.body)) as {
                    update: string;
                };
                Y.applyUpdate(doc, agendaTextBytes(body.update));
                version++;
            }
            return Response.json({
                field: "point:p:text",
                update: agendaTextBase64(Y.encodeStateAsUpdate(doc)),
                stateVector: agendaTextBase64(Y.encodeStateVector(doc)),
                version: 1,
                materializedVersion: version,
            });
        });
        vi.stubGlobal("fetch", fetchMock);
        const onPatch = vi.fn().mockResolvedValue(true);
        const view = render(
            <OutlineEditor
                detail={detail({
                    textProtocol: 1,
                    points: [
                        point("previous"),
                        point("p", {
                            text: "Planning",
                            position: 1,
                            version: 3,
                        }),
                    ],
                })}
                userId="owner"
                onPatch={onPatch}
                onRemove={vi.fn()}
                onAdd={vi.fn().mockResolvedValue(true)}
            />,
        );
        const input = screen.getAllByRole("textbox", {
            name: "Discussion point",
        })[1] as HTMLTextAreaElement;
        input.focus();
        await waitFor(() => expect(input.readOnly).toBe(false));
        fireEvent.change(input, { target: { value: "Planning today" } });
        fireEvent.input(input, { target: { value: "Planning today" } });
        fireEvent.keyDown(input, { key: "Tab" });
        await waitFor(() =>
            expect(onPatch).toHaveBeenCalledWith(
                expect.objectContaining({ id: "p", version: 4 }),
                expect.objectContaining({ parentId: "previous" }),
            ),
        );
        expect(doc.getText(AGENDA_TEXT_NAME).toString()).toBe("Planning today");
        view.unmount();
        doc.destroy();
    });

    it("subscribes while active, reconciles recording views, refetches from the cached cursor and closes on deactivation", async () => {
        vi.useFakeTimers();
        const sources = new Map<
            string,
            {
                onopen: (() => void) | null;
                connected?: () => void;
                onmessage: (() => void) | null;
                close: ReturnType<typeof vi.fn>;
            }
        >();
        class Source {
            onopen: (() => void) | null = null;
            onmessage: (() => void) | null = null;
            onerror: (() => void) | null = null;
            connected?: () => void;
            addEventListener(type: string, callback: () => void) {
                if (type === "connected") this.connected = callback;
            }
            close = vi.fn();
            constructor(url: string) {
                sources.set(url, this);
            }
        }
        vi.stubGlobal("EventSource", Source);
        const fetchMock = vi.fn(async () =>
            Response.json({ unchanged: true, version: 1 }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const initial = detail({ cursor: "1:standalone:idle" });
        const { rerender } = renderHook(
            ({ active }) =>
                useAgenda("agenda", initial, { active, pollEnabled: false }),
            { initialProps: { active: true } },
        );
        const source = sources.get("/api/meetings/agenda/events");
        expect(source).toBeDefined();
        expect(fetchMock).not.toHaveBeenCalled();
        await act(async () => {
            source?.connected?.();
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/meetings/agenda?since=1%3Astandalone%3Aidle",
            expect.objectContaining({ method: "GET" }),
        );
        fetchMock.mockClear();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(60000);
        });
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
            "/api/meetings/agenda?since=1%3Astandalone%3Aidle",
            expect.objectContaining({ method: "GET" }),
        );
        rerender({ active: false });
        expect(source?.close).toHaveBeenCalledOnce();
    });

    it("merges a remote text update into a focused field without losing its caret and shows attribution", async () => {
        const doc = createAgendaTextDoc("Planning");
        const fetchMock = vi.fn(async () =>
            Response.json({
                field: "point:p:text",
                update: agendaTextBase64(Y.encodeStateAsUpdate(doc)),
                stateVector: agendaTextBase64(Y.encodeStateVector(doc)),
                version: 1,
            }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const initial = detail({
            textProtocol: 1,
            points: [point("p", { text: "Planning" })],
        });
        const callbacks = {
            onPatch: vi.fn().mockResolvedValue(true),
            onRemove: vi.fn(),
            onAdd: vi.fn().mockResolvedValue(true),
        };
        const view = render(
            <OutlineEditor detail={initial} userId="owner" {...callbacks} />,
        );
        const input = screen.getByRole("textbox", {
            name: "Discussion point",
        }) as HTMLTextAreaElement;
        fireEvent.focus(input);
        input.focus();
        await waitFor(() => expect(input.readOnly).toBe(false));
        input.setSelectionRange(4, 4);
        doc.getText(AGENDA_TEXT_NAME).insert(0, "Remote ");
        const next = detail({
            ...initial,
            version: 2,
            points: [
                point("p", {
                    text: "Remote Planning",
                    version: 1,
                    updatedByUserId: "editor",
                }),
            ],
            authors: [...initial.authors, { id: "editor", name: "Petr Král" }],
        });
        view.rerender(
            <OutlineEditor detail={next} userId="owner" {...callbacks} />,
        );
        await waitFor(() => expect(input.value).toBe("Remote Planning"));
        expect(document.activeElement).toBe(input);
        expect(input.selectionStart).toBe(11);
        expect(screen.getByTitle("Changed by Petr Král at 10:00")).toBeTruthy();
        expect(callbacks.onPatch).not.toHaveBeenCalled();
        doc.destroy();
    });
});

it("reconciles after readiness even when the initial detail response is still pending", async () => {
    let ready = () => {};
    class Source {
        onmessage: (() => void) | null = null;
        close = vi.fn();
        addEventListener(_type: string, listener: () => void) {
            ready = listener;
        }
    }
    vi.stubGlobal("EventSource", Source);
    let complete: (response: Response) => void = () => {};
    const fetchMock = vi
        .fn()
        .mockImplementationOnce(
            () =>
                new Promise<Response>((resolve) => {
                    complete = resolve;
                }),
        )
        .mockResolvedValue(Response.json({ unchanged: true, version: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useAgenda("agenda", undefined, { pollEnabled: false }));
    await act(async () => {
        ready();
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => {
        complete(Response.json(detail({ cursor: "1:standalone:idle" })));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/meetings/agenda?since=1%3Astandalone%3Aidle",
        expect.objectContaining({ method: "GET" }),
    );
});
