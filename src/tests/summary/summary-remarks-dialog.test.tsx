// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SummaryRemarksDialog } from "@/components/summary/summary-remarks-dialog";

vi.mock("next-intl", () => ({
    useLocale: () => "en",
    useExtracted: () => (message: string) => message,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const fetchMock = vi.fn();
const close = vi.fn();
const run = vi.fn();
const remark = {
    id: "remark-1",
    text: "The client spoke after the break.",
    authorUserId: "owner",
    authorName: "Jitka Dvořáková",
    createdAt: "2026-10-28T10:00:00Z",
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(
        Response.json({
            remarks: [remark],
            preview: {
                available: true,
                profileName: "Meeting notes",
                provider: "Local provider",
                model: "local-model",
            },
        }),
    );
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe.each([
    "private",
    "org",
] as const)("summary remarks dialog in %s", (view) => {
    it.each([
        [
            "profile-unavailable",
            "Choose an available profile to correct this summary.",
        ],
        [
            "provider-unavailable",
            "Configure a summary provider and model to correct this summary.",
        ],
    ])("keeps stored remarks and deletion usable with %s", async (reason, message) => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce(
            Response.json({
                remarks: [remark],
                preview: { available: false, reason },
            }),
        );
        fetchMock.mockResolvedValueOnce(Response.json({ success: true }));
        render(
            <SummaryRemarksDialog
                itemId="item"
                profileId="profile"
                view={view}
                onClose={close}
                onRun={run}
            />,
        );
        expect(await screen.findByText(remark.text)).toBeTruthy();
        expect(screen.getByRole("status").textContent).toBe(message);
        expect(
            (
                screen.getByRole("button", {
                    name: "Correct summary",
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
        expect(
            (screen.getByLabelText("New remark") as HTMLTextAreaElement)
                .disabled,
        ).toBe(false);
        expect(
            (
                screen.getByRole("button", {
                    name: "Cancel",
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(false);
        fireEvent.change(screen.getByLabelText("New remark"), {
            target: { value: "Keep the deadline." },
        });
        fireEvent.click(
            screen.getByRole("button", { name: "Correct summary" }),
        );
        expect(run).not.toHaveBeenCalled();
        await act(async () =>
            fireEvent.click(
                screen.getByRole("button", { name: "Delete remark" }),
            ),
        );
        expect(screen.queryByText(remark.text)).toBeNull();
        expect(fetchMock.mock.calls[1]).toEqual([
            `/api/recordings/item/summary/remarks?remarkId=remark-1${view === "org" ? "&view=org" : ""}`,
            { method: "DELETE" },
        ]);
        expect(run).not.toHaveBeenCalled();
    });
    it("shows the author, time, stored text and actual next-run model", async () => {
        render(
            <SummaryRemarksDialog
                itemId="item"
                profileId="profile"
                view={view}
                onClose={close}
                onRun={run}
            />,
        );
        expect(await screen.findByText(remark.text)).toBeTruthy();
        expect(screen.getByText("JD")).toBeTruthy();
        expect(screen.getByText(remark.authorName)).toBeTruthy();
        expect(document.querySelector("time")?.dateTime).toBe(remark.createdAt);
        const nextRun = screen.getByText(/local-model/);
        expect(nextRun.textContent).toBe(
            "Profile Meeting notes · Local provider · local-model",
        );
        expect(nextRun.querySelector(".font-mono")).toBeNull();
        expect(fetchMock).toHaveBeenCalledWith(
            `/api/recordings/item/summary/remarks?profileId=profile${view === "org" ? "&view=org" : ""}`,
            expect.any(Object),
        );
    });

    it("stores a new remark before requesting the summary revision", async () => {
        fetchMock.mockResolvedValueOnce(
            Response.json({
                remarks: [
                    remark,
                    { ...remark, id: "remark-2", text: "Keep the deadline." },
                ],
            }),
        );
        render(
            <SummaryRemarksDialog
                itemId="item"
                profileId="profile"
                view={view}
                onClose={close}
                onRun={run}
            />,
        );
        await screen.findByText(remark.text);
        fireEvent.change(screen.getByLabelText("New remark"), {
            target: { value: "Keep the deadline." },
        });
        await act(async () =>
            fireEvent.click(
                screen.getByRole("button", { name: "Correct summary" }),
            ),
        );
        expect(fetchMock.mock.calls[1]).toEqual([
            `/api/recordings/item/summary/remarks${view === "org" ? "?view=org" : ""}`,
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ text: "Keep the deadline." }),
            }),
        ]);
        expect(run).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
    });

    it("deletes a remark optimistically without regenerating", async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ success: true }));
        render(
            <SummaryRemarksDialog
                itemId="item"
                profileId="profile"
                view={view}
                onClose={close}
                onRun={run}
            />,
        );
        await screen.findByText(remark.text);
        fireEvent.click(screen.getByRole("button", { name: "Delete remark" }));
        expect(screen.queryByText(remark.text)).toBeNull();
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(fetchMock.mock.calls[1]).toEqual([
            `/api/recordings/item/summary/remarks?remarkId=remark-1${view === "org" ? "&view=org" : ""}`,
            { method: "DELETE" },
        ]);
        expect(run).not.toHaveBeenCalled();
    });

    it("restores a remark when deletion fails", async () => {
        fetchMock.mockResolvedValueOnce(Response.json({}, { status: 409 }));
        render(
            <SummaryRemarksDialog
                itemId="item"
                profileId="profile"
                view={view}
                onClose={close}
                onRun={run}
            />,
        );
        await screen.findByText(remark.text);
        await act(async () =>
            fireEvent.click(
                screen.getByRole("button", { name: "Delete remark" }),
            ),
        );
        expect(screen.getByText(remark.text)).toBeTruthy();
        expect(run).not.toHaveBeenCalled();
    });
});
