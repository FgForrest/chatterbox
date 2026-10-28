// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }));

vi.mock("sonner", () => ({
    toast: { success: toastSuccess, error: vi.fn() },
}));

import { MarkdownActions } from "@/components/dashboard/markdown-actions";

describe("MarkdownActions", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    beforeEach(() => {
        vi.clearAllMocks();
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText },
        });
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("offers the rendered transcript Markdown as a download", () => {
        render(
            <MarkdownActions
                recordingId="rec-1"
                kind="transcript"
                source="plaud"
            />,
        );

        expect(
            screen
                .getByRole("link", { name: "Download transcript Markdown" })
                .getAttribute("href"),
        ).toBe("/api/recordings/rec-1/markdown/transcript?source=plaud");
    });

    it("uses summary labels and container for compact summary actions", () => {
        render(
            <MarkdownActions
                recordingId="rec-1"
                kind="summary"
                source="riffado"
                collapseAtNarrowWidth
            />,
        );
        const actions = screen.getByRole("button", { name: "Summary actions" });
        expect(actions.title).toBe("Summary actions");
        expect(actions.parentElement?.className).toBe(
            "@min-[560px]/summary:hidden",
        );
        expect(
            screen.getByRole("link", { name: "Download summary Markdown" })
                .parentElement?.className,
        ).toContain("@min-[560px]/summary:flex");
        fireEvent.keyDown(actions, { key: "Enter" });
        expect(
            screen
                .getByRole("menuitem", { name: "Download summary Markdown" })
                .getAttribute("href"),
        ).toContain("/markdown/summary?");
    });

    it("disables download navigation and menu selection while preserving the enabled download", () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const props = {
            recordingId: "rec-1",
            kind: "agenda" as const,
            source: "agenda",
            collapseAtNarrowWidth: true,
        };
        const { rerender } = render(<MarkdownActions {...props} disabled />);
        const download = screen.getByLabelText("Download agenda Markdown");
        expect(download.getAttribute("href")).toBeNull();
        expect(download.getAttribute("aria-disabled")).toBe("true");
        expect(download.getAttribute("tabindex")).toBe("-1");
        expect(download.className).toContain("opacity-50");
        expect(download.className).toContain("pointer-events-none");
        fireEvent.click(download);
        fireEvent.keyDown(download, { key: "Enter" });
        fireEvent.keyDown(
            screen.getByRole("button", { name: "Agenda actions" }),
            { key: "Enter" },
        );
        const menuDownload = screen.getByRole("menuitem", {
            name: "Download agenda Markdown",
        });
        expect(menuDownload.getAttribute("aria-disabled")).toBe("true");
        expect(menuDownload.hasAttribute("data-disabled")).toBe(true);
        expect(menuDownload.getAttribute("href")).toBeNull();
        fireEvent.click(menuDownload);
        fireEvent.keyDown(menuDownload, { key: "Enter" });
        expect(screen.getByRole("menu")).toBeTruthy();
        expect(fetchMock).not.toHaveBeenCalled();
        fireEvent.keyDown(menuDownload, { key: "Escape" });
        rerender(<MarkdownActions {...props} disabled={false} />);
        expect(
            screen
                .getByRole("link", { name: "Download agenda Markdown" })
                .getAttribute("href"),
        ).toContain("/markdown/agenda?");
    });
    it("copies the same summary Markdown returned by the download route", async () => {
        const markdown = "---\ntitle: Summary\n---\n";
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(markdown, {
                    headers: { "Content-Type": "text/markdown" },
                }),
            ),
        );
        render(
            <MarkdownActions
                recordingId="rec-1"
                kind="summary"
                source="riffado"
            />,
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Copy summary Markdown" }),
        );

        await waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown));
        expect(fetch).toHaveBeenCalledWith(
            "/api/recordings/rec-1/markdown/summary?source=riffado",
            { cache: "no-store" },
        );
        expect(toastSuccess).toHaveBeenCalledWith("Summary Markdown copied");
    });
});
