import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentParticipant } from "@/lib/content/types";
import {
    mailCandidates,
    participantProposals,
} from "@/lib/learn/mail-candidates";
import type { ReviewCandidate } from "@/lib/learn/validate";
import { isInternalMailAddress } from "@/lib/mail/internal-address";

const { mockEnv } = vi.hoisted(() => ({
    mockEnv: { MAIL_DOMAIN: "inbound.example.test" as string | undefined },
}));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
afterEach(() => {
    mockEnv.MAIL_DOMAIN = "inbound.example.test";
});

const reasons = {
    newPerson: "A participant of the mail",
    knownPerson: "Another address of a known person",
};
const participant = (address: string): ContentParticipant => ({
    ref: "p1",
    displayName: "Luma Veln",
    address,
    roles: ["from"],
});

describe("internal mail addresses", () => {
    it.each([
        "mailbox",
        "mailbox+folder",
        "mailbox.abcdefghij",
        "unallocated",
    ])("recognizes %s on the exact domain, regardless of case", (local) => {
        expect(isInternalMailAddress(` ${local}@INBOUND.EXAMPLE.TEST `)).toBe(
            true,
        );
        expect(isInternalMailAddress(`${local}@sub.inbound.example.test`)).toBe(
            false,
        );
        expect(
            isInternalMailAddress(`${local}@inbound.example.test.other`),
        ).toBe(false);
        expect(isInternalMailAddress(`${local}@example.test`)).toBe(false);
    });
    it.each([
        "",
        "inbound.example.test",
        "@inbound.example.test",
        "person@",
    ])("does not treat %j as internal", (address) => {
        expect(isInternalMailAddress(address)).toBe(false);
    });
    it("compares a configured uppercase domain case-insensitively", () => {
        mockEnv.MAIL_DOMAIN = "INBOUND.EXAMPLE.TEST";
        expect(isInternalMailAddress("mailbox@inbound.example.test")).toBe(
            true,
        );
    });
    it("leaves self-host without mail unchanged", () => {
        mockEnv.MAIL_DOMAIN = undefined;
        const address = "mailbox@inbound.example.test";
        expect(isInternalMailAddress(address)).toBe(false);
        expect(
            participantProposals(
                [participant(address)],
                [],
                new Map(),
                (value) => value,
                reasons,
            ),
        ).toHaveLength(1);
    });
    it.each([
        false,
        true,
    ])("never proposes an internal address (known person: %s)", (known) => {
        const knownByName = new Map(known ? [["luma veln", "person-1"]] : []);
        expect(
            participantProposals(
                [participant("mailbox@INBOUND.EXAMPLE.TEST")],
                [],
                knownByName,
                (value) => value,
                reasons,
            ),
        ).toEqual([]);
        expect(
            participantProposals(
                [participant("luma@example.test")],
                [],
                knownByName,
                (value) => value,
                reasons,
            ),
        ).toHaveLength(1);
    });
    it("drops model speaker proposals for mail participants", () => {
        expect(
            mailCandidates(
                [
                    {
                        kind: "speaker",
                        fingerprint: "speaker",
                        preTicked: false,
                        payload: {
                            label: "p1",
                            personId: "person-1",
                            evidenceMs: [],
                            reason: "A participant",
                        },
                    },
                ],
                [],
                [participant("mailbox@inbound.example.test")],
            ),
        ).toEqual([]);
    });
    it("retains a person named in the body without proposing an internal participant link", () => {
        const record: ReviewCandidate = {
            kind: "new_record",
            fingerprint: "name",
            preTicked: false,
            payload: {
                ref: "new-person",
                kind: "person",
                name: "Luma Veln",
                typeKey: null,
                speakerLabel: "p1",
                evidenceMs: [0],
                reason: "Named in the body",
            },
        };
        const candidates = mailCandidates(
            [record],
            [
                {
                    segmentIndex: 0,
                    charStart: 0,
                    charEnd: 9,
                    role: "body",
                    participantRef: "p1",
                },
            ],
            [participant("mailbox@inbound.example.test")],
        );
        expect(candidates[0]?.payload).toMatchObject({
            name: "Luma Veln",
            speakerLabel: undefined,
        });
        expect(candidates[0]?.payload).not.toHaveProperty("address");
    });
});
