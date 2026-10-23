// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { IntlProvider, useLocale } from "use-intl/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSpeakerSource } from "@/components/learn/speaker-source";
import type { AppLocale } from "@/lib/i18n/config";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import czech from "../../../messages/cs-CZ.json";
import english from "../../../messages/en.json";

vi.mock("next-intl", () => ({
    useExtracted: () => {
        const locale = useLocale() as AppLocale;
        return (message: string) => translatedSourceMessage(locale, message);
    },
}));
afterEach(cleanup);
function Source({ source }: { source: "calendar" | "meet" }) {
    const describe = useSpeakerSource();
    return (
        <span>
            {describe({
                source,
                guess: {
                    confidence: 0.49,
                    clues: [source],
                    matchedByEmail: true,
                },
            })}
        </span>
    );
}
it.each([
    ["en", "calendar", "Invited in Calendar · Matched by e-mail · Guess"],
    ["en", "meet", "Joined in Google Meet · Matched by e-mail · Guess"],
    [
        "cs-CZ",
        "calendar",
        "Pozván v Kalendáři · Spárováno podle e-mailu · Odhad",
    ],
    [
        "cs-CZ",
        "meet",
        "Připojen v Google Meet · Spárováno podle e-mailu · Odhad",
    ],
] as const)("shows %s %s provenance", (locale, source, expected) => {
    render(
        <IntlProvider
            locale={locale}
            messages={locale === "en" ? english : czech}
            timeZone="UTC"
        >
            <Source source={source} />
        </IntlProvider>,
    );
    expect(screen.getByText(expected)).toBeTruthy();
});
