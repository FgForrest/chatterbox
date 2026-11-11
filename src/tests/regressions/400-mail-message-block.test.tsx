// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailDetailPane } from "@/components/mail/mail-detail-pane";
import { OPEN_WORKFLOW_WIDGET_EVENT } from "@/components/pipeline/workflow-widget";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Recording } from "@/types/recording";

vi.mock("next/navigation", () => ({
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-intl", () => ({
    useExtracted:
        () =>
        (text: string, values: Record<string, string> = {}) =>
            text.replace(
                /\{(\w+)\}/g,
                (_, key: string) => values[key] ?? `{${key}}`,
            ),
    useLocale: () => "en",
}));
vi.mock("@/components/items/item-header", () => ({ ItemHeader: () => null }));
vi.mock("@/components/pipeline/item-workflow", () => ({
    ItemWorkflow: () => null,
}));
vi.mock("@/components/mail/mail-summary-card", () => ({
    MailSummaryCard: () => null,
}));
vi.mock("@/components/mail/mail-learn-card", () => ({
    MailLearnCard: () => null,
}));
vi.mock("@/components/sharing/person-sharing", () => ({
    ReceivedItemBanner: () => null,
}));
vi.mock("@/components/recordings/recording-folder-tags", () => ({
    RecordingFolderTags: () => null,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mail: Recording = {
    id: "mail-400",
    filename: "Harbor proposal",
    kind: "mail",
    duration: 0,
    filesize: 100,
    startTime: "2026-10-18T12:00:00.000Z",
    deviceSn: "mail",
};
const props = {
    dateTimeFormat: "absolute" as const,
    onBackToList: vi.fn(),
    hiddenOnMobile: false,
    onChanged: vi.fn(),
    folders: [],
    folderAssignments: [],
    onSelectFolder: vi.fn(),
    onAddToFolder: vi.fn(),
    onRemoveFromFolder: vi.fn(),
    onMoveBetweenFolders: vi.fn(),
};
const markdown =
    "# Harbor proposal\n\n**From:** Mira <mira@example.com>\n\nMessage body\n";
const copy = vi.fn().mockResolvedValue(undefined);
const scroll = vi.fn();

function pane(item: Recording = mail, query = "") {
    return (
        <TooltipProvider>
            <MailDetailPane {...props} mail={item} itemLinkQuery={query} />
        </TooltipProvider>
    );
}

beforeEach(() => {
    copy.mockClear();
    scroll.mockClear();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        writable: true,
        value: scroll,
    });
    vi.stubGlobal("navigator", {
        ...navigator,
        clipboard: { writeText: copy },
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
            if (input.includes("/markdown")) return new Response(markdown);
            return new Response(
                JSON.stringify({
                    id: mail.id,
                    isOwn: true,
                    subject: mail.filename,
                    sentAt: mail.startTime,
                    receivedAt: mail.startTime,
                    sizeBytes: 100,
                    senderVerified: true,
                    hasRaw: true,
                    rawReapedAt: null,
                    participants: [],
                    attachments: [],
                    processing: null,
                    segments: [
                        {
                            index: 0,
                            role: "body",
                            depth: 0,
                            text: "Message body",
                            participantRef: null,
                            at: null,
                        },
                    ],
                    html: "<p>Formatted body</p>",
                }),
            );
        }),
    );
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe.each([
    { view: "private", isOwn: true },
    { view: "org", isOwn: true },
    { view: "org", isOwn: false },
    { view: "received", isOwn: false },
] as const)("Message actions in $view (owner: $isOwn)", ({ view, isOwn }) => {
    it("offers Markdown to every reader and the original only to its owner", async () => {
        render(pane({ ...mail, view, isOwn }));
        const download = await screen.findByRole("link", {
            name: "Download message Markdown",
        });
        expect(download.getAttribute("href")).toBe(
            `/api/mail/mail-400/markdown${view === "private" ? "" : `?view=${view}`}`,
        );
        expect(
            screen.getByRole("button", { name: "Copy message Markdown" }),
        ).toBeTruthy();
        expect(
            Boolean(
                screen.queryByRole("link", {
                    name: "Download the original message",
                }),
            ),
        ).toBe(isOwn);
        expect(download.parentElement?.className).toContain(
            "@min-[560px]/workflow:flex",
        );
        expect(
            screen.getByRole("button", { name: "Message actions" })
                .parentElement?.className,
        ).toContain("@min-[560px]/workflow:hidden");
    });

    it("keeps the icon toggle and copies text Markdown while formatted", async () => {
        render(pane({ ...mail, view, isOwn }));
        const toggle = await screen.findByRole("button", {
            name: "Show formatted",
        });
        expect(toggle.textContent).toBe("");
        expect(toggle.getAttribute("aria-pressed")).toBe("false");
        expect(toggle.className).toContain("size-8");
        const textIcon = toggle.querySelector("svg")?.innerHTML;
        expect(textIcon).toBeTruthy();
        fireEvent.click(toggle);
        await screen.findByTitle("Formatted mail");
        expect(toggle.getAttribute("aria-label")).toBe("Show text");
        expect(toggle.getAttribute("aria-pressed")).toBe("true");
        expect(toggle.querySelector("svg")?.innerHTML).not.toBe(textIcon);
        expect(toggle.textContent).toBe("");
        expect(
            screen.getByRole("link", { name: "Download message Markdown" }),
        ).toBeTruthy();
        fireEvent.click(
            screen.getByRole("button", { name: "Copy message Markdown" }),
        );
        await waitFor(() => expect(copy).toHaveBeenCalledWith(markdown));
        fireEvent.click(toggle);
        expect(toggle.getAttribute("aria-pressed")).toBe("false");
    });
});

it("starts expanded, collapses, expands, and handles the open-widget event", async () => {
    render(pane());
    const collapse = await screen.findByRole("button", {
        name: "Collapse message",
    });
    const body = screen
        .getByText("Message body")
        .closest("[data-widget-body]")?.parentElement;
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(collapse);
    expect(body?.hasAttribute("hidden")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Expand message" }));
    expect(body?.hasAttribute("hidden")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Collapse message" }));
    fireEvent(
        window,
        new CustomEvent(OPEN_WORKFLOW_WIDGET_EVENT, {
            detail: { id: `mail-message-${mail.id}` },
        }),
    );
    expect(body?.hasAttribute("hidden")).toBe(false);
});

it("offers the same Markdown download and copy through the narrow menu", async () => {
    render(pane());
    const trigger = await screen.findByRole("button", {
        name: "Message actions",
    });
    fireEvent.pointerDown(trigger, {
        button: 0,
        ctrlKey: false,
        pointerType: "mouse",
    });
    const download = await screen.findByRole("menuitem", {
        name: "Download message Markdown",
    });
    expect(download.getAttribute("href")).toBe("/api/mail/mail-400/markdown");
    fireEvent.click(
        screen.getByRole("menuitem", { name: "Copy message Markdown" }),
    );
    await waitFor(() => expect(copy).toHaveBeenCalledWith(markdown));
});

it("expands and returns to text before scrolling to highlighted evidence", async () => {
    const { rerender } = render(pane());
    fireEvent.click(
        await screen.findByRole("button", { name: "Show formatted" }),
    );
    await screen.findByTitle("Formatted mail");
    fireEvent.click(screen.getByRole("button", { name: "Collapse message" }));
    scroll.mockImplementation(function (this: HTMLElement) {
        expect(this.id).toBe("mail-evidence-highlight");
        expect(this.closest("[hidden]")).toBeNull();
    });
    rerender(
        pane(
            mail,
            "recording=mail-400&evidenceSegment=0&evidenceStart=0&evidenceEnd=7",
        ),
    );
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(screen.queryByTitle("Formatted mail")).toBeNull();
    expect(
        screen
            .getByRole("button", { name: "Collapse message" })
            .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
        document.getElementById("mail-evidence-highlight")?.textContent,
    ).toBe("Message");
});
