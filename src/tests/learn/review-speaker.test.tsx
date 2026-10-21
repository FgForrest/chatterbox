// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewSpeaker } from "@/components/learn/review-speaker";
import { SpeakerAccentContext } from "@/components/people/speaker-accent-context";
import { speakerAccent } from "@/components/people/speaker-accents";
import type { AppLocale } from "@/lib/i18n/config";
import { translatedSourceMessage } from "@/lib/i18n/messages";

let reviewLocale: AppLocale = "en";

vi.mock("next-intl", () => ({
    useExtracted:
        () => (message: string, values?: Record<string, string | number>) =>
            translatedSourceMessage(reviewLocale, message, values),
}));

afterEach(cleanup);

describe.each(["cs-CZ", "en"] as const)("ReviewSpeaker in %s", (locale) => {
    it.each([
        ["Speaker 0", "0"],
        ["Speaker 1", "1"],
        ["SPEAKER_2", "2"],
        ["speaker_3", "3"],
        ["Luma Veln", null],
        ["Speaker Veln", null],
    ])("localizes only provider defaults: %s", (label, number) => {
        const onPlay = vi.fn();
        const onTick = vi.fn();
        reviewLocale = locale;
        render(
            <ReviewSpeaker
                label={label}
                person={{ name: "Neri Vosk" }}
                accent={speakerAccent(0)}
                ticked={false}
                blocked={false}
                disabled={false}
                recorder={false}
                onlyFirstName={false}
                reason="Stored reason remains unchanged."
                evidence={null}
                waits={null}
                onTick={onTick}
                onPick={vi.fn()}
                onUnknown={vi.fn()}
                onPlay={onPlay}
            />,
        );
        const shown =
            number === null
                ? label
                : `${locale === "cs-CZ" ? "Mluvčí" : "Speaker"} ${number}`;
        expect(screen.getByText(shown)).toBeTruthy();
        expect(
            screen.getByText("Stored reason remains unchanged."),
        ).toBeTruthy();
        const checkbox = screen.getByRole("checkbox", {
            name:
                locale === "cs-CZ"
                    ? `Přijmout ${shown} jako Neri Vosk`
                    : `Accept ${shown} as Neri Vosk`,
        });
        fireEvent.click(checkbox);
        expect(onTick).toHaveBeenCalledWith(true);
        fireEvent.click(
            screen.getByRole("button", {
                name:
                    locale === "cs-CZ"
                        ? `Přehrát promluvu: ${shown}`
                        : `Play a turn of ${shown}`,
            }),
        );
        expect(onPlay).toHaveBeenCalledOnce();
    });
});

it("uses a confirmed merged voice's colour in the review", () => {
    reviewLocale = "en";
    const { container } = render(
        <SpeakerAccentContext value={new Map([["speaker_1", 0]])}>
            <ReviewSpeaker
                label="speaker_1"
                person={{ name: "Jan" }}
                accent={speakerAccent(1)}
                ticked
                blocked={false}
                disabled={false}
                recorder={false}
                onlyFirstName={false}
                reason=""
                evidence={null}
                waits={null}
                onTick={vi.fn()}
                onPick={vi.fn()}
                onUnknown={vi.fn()}
            />
        </SpeakerAccentContext>,
    );
    expect(container.querySelector(".bg-primary.rounded-full")).toBeTruthy();
    expect(container.querySelector(".bg-emerald-500")).toBeNull();
});
