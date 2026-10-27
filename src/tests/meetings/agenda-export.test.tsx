// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import type { TranslationValues } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgendaExport } from "@/components/meetings/agenda-export";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import { detail } from "./ui-fixtures";

vi.mock("next-intl", () => ({
    useExtracted: () => (text: string, values?: TranslationValues) =>
        translatedSourceMessage("en", text, values),
    useLocale: () => "en",
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const fetchMock = vi.fn();
beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
        init?.method === "POST"
            ? Response.json({
                  needsConsent: true,
                  connectUrl:
                      "/api/integrations/google/connect?purpose=calendar-write",
              })
            : new Response("# Acme\n\n## Discussion points\n- Review dates"),
    );
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
});
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});
async function openMenu() {
    const trigger = screen.getByRole("button", { name: "Agenda export" });
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
}
describe("export visibility", () => {
    it("hides Calendar export without a linked event", async () => {
        render(<AgendaExport detail={detail()} />);
        await openMenu();
        expect(
            screen.getByRole("menuitem", { name: "Copy agenda Markdown" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("menuitem", { name: "Download agenda Markdown" }),
        ).toBeTruthy();
        expect(
            screen.queryByRole("menuitem", { name: /Google Calendar/ }),
        ).toBeNull();
    });
    it("disables Calendar export with the organizer reason", async () => {
        render(
            <AgendaExport
                detail={detail({
                    calendarEventId: "event",
                    calendar: {
                        organizer: { self: true, name: "Dana Nováková" },
                        htmlLink: "https://calendar.google.com",
                        attendeeCount: 3,
                        externalInviteeCount: 1,
                    },
                    canExportCalendar: false,
                })}
            />,
        );
        await openMenu();
        expect(
            screen
                .getByRole("menuitem", { name: /Google Calendar/ })
                .getAttribute("aria-disabled"),
        ).toBe("true");
        expect(
            screen.getByText(/Only the event organizer, Dana Nováková/),
        ).toBeTruthy();
    });
    it("copies the server Markdown and downloads the same endpoint", async () => {
        render(<AgendaExport detail={detail()} />);
        await openMenu();
        expect(
            screen
                .getByRole("menuitem", { name: "Download agenda Markdown" })
                .getAttribute("href"),
        ).toBe("/api/meetings/agenda/markdown?locale=en");
        await act(async () =>
            fireEvent.click(
                screen.getByRole("menuitem", { name: "Copy agenda Markdown" }),
            ),
        );
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
            expect.stringContaining("Review dates"),
        );
    });
    it.each([
        true,
        false,
    ])("copies on HTTP without Clipboard API and reports the result %s", async (copied) => {
        Object.defineProperty(navigator, "clipboard", { value: undefined });
        const copy = vi.fn(() => {
            expect(
                document.getSelection()?.toString() ||
                    document.querySelector("textarea")?.value,
            ).toContain("Review dates");
            return copied;
        });
        Object.defineProperty(document, "execCommand", {
            configurable: true,
            value: copy,
        });
        let finish: (response: Response) => void = () => {};
        const response = new Promise<Response>((resolve) => {
            finish = resolve;
        });
        fetchMock.mockReturnValueOnce(response);
        render(<AgendaExport detail={detail()} />);
        const trigger = screen.getByRole("button", { name: "Agenda export" });
        act(() => trigger.focus());
        await openMenu();
        await act(async () =>
            fireEvent.click(
                screen.getByRole("menuitem", { name: "Copy agenda Markdown" }),
            ),
        );
        await waitFor(() => expect(document.activeElement).toBe(trigger));
        await act(async () => finish(new Response("# Acme\nReview dates")));
        expect(copy).toHaveBeenCalledWith("copy");
        expect(document.querySelector("textarea")).toBeNull();
        expect(document.activeElement).toBe(trigger);
        if (copied)
            expect(toast.success).toHaveBeenCalledWith(
                "Agenda Markdown copied",
            );
        else
            expect(toast.error).toHaveBeenCalledWith(
                "Could not copy the agenda",
            );
    });
    it.each([
        true,
        null,
    ])("previews without tasks and hands off consent with organizer permission %s", async (canExportCalendar) => {
        render(
            <AgendaExport
                detail={detail({
                    calendarEventId: "event",
                    canExportCalendar,
                    calendar: {
                        organizer: { self: true, name: undefined },
                        htmlLink: "https://calendar.google.com",
                        attendeeCount: 4,
                        externalInviteeCount: 2,
                    },
                })}
            />,
        );
        await openMenu();
        expect(
            screen
                .getByRole("menuitem", { name: /Google Calendar/ })
                .getAttribute("aria-disabled"),
        ).not.toBe("true");
        if (canExportCalendar === null)
            expect(
                screen.getByText(
                    "Organizer access will be checked when you export.",
                ),
            ).toBeTruthy();
        await act(async () =>
            fireEvent.click(
                screen.getByRole("menuitem", { name: /Google Calendar/ }),
            ),
        );
        await waitFor(() =>
            expect(
                screen.getByRole("region", { name: "Calendar export preview" })
                    .textContent,
            ).toContain("Review dates"),
        );
        expect(screen.getByRole("checkbox")).toHaveProperty("checked", false);
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining("includeTasks=false"),
            expect.any(Object),
        );
        expect(
            screen.getByText(/including 2 outside your organization/),
        ).toBeTruthy();
        await act(async () =>
            fireEvent.click(
                screen.getByRole("button", { name: "Write to event" }),
            ),
        );
        expect(
            screen
                .getByRole("link", { name: "Continue to Google" })
                .getAttribute("href"),
        ).toContain("purpose=calendar-write");
        expect(
            fetchMock.mock.calls.filter((call) => call[1]?.method === "POST"),
        ).toHaveLength(1);
        expect(
            JSON.parse(
                String(
                    fetchMock.mock.calls.find(
                        (call) => call[1]?.method === "POST",
                    )?.[1].body,
                ),
            ),
        ).toEqual({ includeTasks: false, locale: "en" });
    });
    it("shows the fresh organizer refusal when cached permission was unknown", async () => {
        render(
            <AgendaExport
                detail={detail({
                    calendarEventId: "event",
                    canExportCalendar: null,
                })}
            />,
        );
        await openMenu();
        await act(async () =>
            fireEvent.click(
                screen.getByRole("menuitem", { name: /Google Calendar/ }),
            ),
        );
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Write to event" }),
            ).toHaveProperty("disabled", false),
        );
        fetchMock.mockResolvedValueOnce(
            Response.json(
                {
                    error: "Only the event organizer can export the agenda",
                    code: "FORBIDDEN",
                },
                { status: 403 },
            ),
        );
        await act(async () =>
            fireEvent.click(
                screen.getByRole("button", { name: "Write to event" }),
            ),
        );
        expect(toast.error).toHaveBeenCalledWith(
            "Only the event organizer can export the agenda",
        );
        expect(screen.getByRole("dialog")).toBeTruthy();
    });
});
