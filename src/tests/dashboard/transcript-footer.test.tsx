// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    TranscriptionPanel,
    type TranscriptOption,
} from "@/components/dashboard/transcription-panel";

vi.mock("@/components/summary/summary-widget", () => ({
    SummaryWidget: () => null,
}));
vi.mock("@/components/learn/learn-review", () => ({ LearnReview: () => null }));
vi.mock("@/components/dashboard/transcribe-in-browser-button", () => ({
    TranscribeInBrowserButton: () => null,
}));

function panel(transcript: Partial<TranscriptOption> = {}) {
    const onTranscribe = vi.fn();
    render(
        <TranscriptionPanel
            recording={{
                id: "rec-footer",
                filename: "Meeting",
                duration: 1000,
                filesize: 100,
                startTime: new Date(0).toISOString(),
                deviceSn: "local",
            }}
            transcripts={[
                {
                    source: "riffado",
                    text: "Hello world.",
                    language: "cs",
                    provider: "Test provider",
                    model: "Test model",
                    ...transcript,
                },
            ]}
            isTranscribing={false}
            onTranscribe={onTranscribe}
        />,
    );
    return { onTranscribe, line: screen.getByTestId("transcript-provenance") };
}

beforeEach(() => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({})),
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function facts(line: HTMLElement) {
    return Array.from(line.children).flatMap((item) => {
        const dot = item.firstElementChild?.getAttribute("aria-hidden");
        const text = item.textContent ?? "";
        return dot === "true" ? ["·", text.slice(1)] : [text];
    });
}

describe("transcript footer provenance", () => {
    it.each([
        ["riffado", null],
        ["plaud", "Plaud"],
        ["mixed", "Mix"],
    ] as const)("renders ordered plain-text facts for %s", (source, label) => {
        const { line } = panel({ source });
        const expected = [
            ...(label ? [label] : []),
            "Test provider",
            "Test model",
            "Czech (detected)",
            "2 words",
            "12 characters",
        ];
        expect(facts(line)).toEqual(
            expected.flatMap((text, index) => (index ? ["·", text] : [text])),
        );
        expect(within(line).queryByText("Custom")).toBeNull();
        expect(line.querySelector(".font-mono, .bg-muted")).toBeNull();
        expect(line.classList.contains("text-xs")).toBe(true);
        expect(line.classList.contains("text-muted-foreground")).toBe(true);
        const items = Array.from(line.children);
        expect(items).toHaveLength(expected.length);
        expect(items[0].querySelector('[aria-hidden="true"]')).toBeNull();
        for (const item of items.slice(1)) {
            expect(item.firstElementChild?.textContent).toBe("·");
            expect(item.firstElementChild?.getAttribute("aria-hidden")).toBe(
                "true",
            );
        }
    });

    it("omits absent source, provider and model without stray separators", () => {
        const { line } = panel({ provider: "", model: undefined });
        expect(facts(line)).toEqual([
            "Czech (detected)",
            "·",
            "2 words",
            "·",
            "12 characters",
        ]);
    });

    it("keeps the language pencil and follow-up controls working in the line", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({
                    confirmedLanguage: "hu",
                    canChange: true,
                    needsResummary: true,
                    needsTitleRegeneration: true,
                }),
            ),
        );
        const { line, onTranscribe } = panel();
        const pencil = await within(line).findByRole("button", {
            name: "Change transcript language",
        });
        expect(
            within(line).getByRole("button", { name: "Re-summarize" }),
        ).toBeTruthy();
        expect(
            within(line).getByRole("button", { name: "Regenerate title" }),
        ).toBeTruthy();
        fireEvent.click(
            within(line).getByRole("button", {
                name: "Re-transcribe in Hungarian",
            }),
        );
        const dialog = screen.getByRole("alertdialog");
        fireEvent.click(
            within(dialog).getByRole("button", { name: "Re-transcribe" }),
        );
        expect(onTranscribe).toHaveBeenCalledWith("riffado", true, "hu");
        fireEvent.click(pencil);
        expect(
            within(line)
                .getByLabelText("Transcript language")
                .getAttribute("aria-expanded"),
        ).toBe("true");
        expect(screen.getByRole("option", { name: "Czech" })).toBeTruthy();
    });
});
