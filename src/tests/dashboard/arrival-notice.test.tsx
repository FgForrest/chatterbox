// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import type { TranslationValues } from "use-intl/core";
import { IntlProvider, useTranslations } from "use-intl/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArrivalNotice } from "@/components/dashboard/arrival-notice";
import { messagesForLocale } from "@/lib/i18n/messages";
import type { Recording } from "@/types/recording";

vi.mock("next-intl", () => ({
    useLocale: () => "cs-CZ",
    useExtracted: () => {
        const translate = useTranslations();
        const ids = new Map(
            Object.entries(messagesForLocale("en")).map(([id, source]) => [
                source,
                id,
            ]),
        );
        return (source: string, values?: TranslationValues) =>
            translate(ids.get(source) ?? source, values);
    },
}));

function Czech({ children }: PropsWithChildren) {
    return (
        <IntlProvider locale="cs-CZ" messages={messagesForLocale("cs-CZ")}>
            {children}
        </IntlProvider>
    );
}

const recording: Recording = {
    id: "orbit",
    filename: "Zápisky z oběžné dráhy",
    duration: 65_000,
    startTime: "2026-10-22T10:00:00Z",
    filesize: 1000,
    deviceSn: "uploaded",
};

afterEach(cleanup);

describe("Czech arrival notice", () => {
    it.each([
        [1, "+1 další"],
        [2, "+2 další"],
        [5, "+5 dalších"],
    ] as const)("pluralizes %s additional arrivals", (more, expected) => {
        render(
            <ArrivalNotice
                recording={recording}
                more={more}
                dateTimeFormat="iso"
                onOpen={vi.fn()}
                onClose={vi.fn()}
            />,
            { wrapper: Czech },
        );
        expect(screen.getByText("Nová nahrávka")).toBeTruthy();
        expect(screen.getByText(expected)).toBeTruthy();
        expect(
            screen.getByRole("button", {
                name: `Otevřít „${recording.filename}“`,
            }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Zavřít upozornění" }),
        ).toBeTruthy();
    });
});
