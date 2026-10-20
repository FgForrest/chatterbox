import { describe, expect, it } from "vitest";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import { participantProposals } from "@/lib/learn/mail-candidates";

describe.each([
    "cs-CZ",
    "en",
] as const)("mail participant reasons in %s", (locale) => {
    it.each([
        false,
        true,
    ])("localizes a header proposal (known: %s)", (known) => {
        const proposals = participantProposals(
            [
                {
                    ref: "p1",
                    displayName: "Luma Veln",
                    address: "luma@example.test",
                    roles: ["from"],
                },
            ],
            [],
            new Map(known ? [["luma veln", "person-1"]] : []),
            (address) => address,
            {
                knownPerson: translatedSourceMessage(
                    locale,
                    "Another address of a known person",
                ),
                newPerson: translatedSourceMessage(
                    locale,
                    "A participant of the mail",
                ),
            },
        );
        expect(proposals).toHaveLength(1);
        expect(proposals[0]?.payload).toMatchObject({
            name: "Luma Veln",
            speakerLabel: "p1",
            address: "luma@example.test",
            reason:
                locale === "cs-CZ"
                    ? known
                        ? "Další adresa známé osoby"
                        : "Účastník zprávy"
                    : known
                      ? "Another address of a known person"
                      : "A participant of the mail",
            ...(known ? { maybe: { personId: "person-1" } } : {}),
        });
    });
});
