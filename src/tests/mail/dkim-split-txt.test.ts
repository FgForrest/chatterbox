import { promises as dnsPromises } from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    authenticateMessage,
    logDkimRefusal,
    resolveDkimDns,
} from "@/lib/mail/dkim";
import {
    rawMessage,
    signMessage,
    testSigner,
} from "@/tests/mail/dkim-fixtures";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("DKIM DNS resolution", () => {
    it.each([
        ["Node", [["first", "second"]]],
        ["Bun", [["first"], ["second"]]],
    ])("normalizes the %s split-TXT answer shape", async (_runtime, answer) => {
        vi.spyOn(dnsPromises, "resolve").mockResolvedValue(answer as never);

        await expect(
            resolveDkimDns("mail._domainkey.example.com", "TXT"),
        ).resolves.toEqual([["first", "second"]]);
    });

    it.each([
        ["a non-DKIM TXT name", "example.com", "TXT", [["one"], ["two"]]],
        ["a non-TXT lookup", "mail._domainkey.example.com", "A", ["192.0.2.1"]],
    ])("passes through %s", async (_case, name, type, answer) => {
        vi.spyOn(dnsPromises, "resolve").mockResolvedValue(answer as never);

        await expect(resolveDkimDns(name, type)).resolves.toBe(answer);
    });

    it("preserves DNS error codes", async () => {
        const error = Object.assign(new Error("no record"), {
            code: "ENODATA",
        });
        vi.spyOn(dnsPromises, "resolve").mockRejectedValue(error);

        await expect(
            resolveDkimDns("mail._domainkey.example.com", "TXT"),
        ).rejects.toBe(error);
        expect(error.code).toBe("ENODATA");
    });
});

describe("split DKIM keys", () => {
    const signer = testSigner("example.com", "mail");
    const first = signer.record.slice(0, 255);
    const rest = signer.record.slice(255);

    it.each([
        ["Node", [[first, rest]]],
        ["Bun", [[first], [rest]]],
    ])("verifies a generated 2048-bit key with the %s DNS shape", async (_runtime, answer) => {
        expect(rest.length).toBeGreaterThan(0);
        vi.spyOn(dnsPromises, "resolve").mockResolvedValue(answer as never);
        const now = new Date();
        const raw = await signMessage(
            rawMessage(
                [
                    "From: sender@example.com",
                    "To: recipient@example.org",
                    "Subject: Split DKIM key",
                    "Date: Fri, 09 Oct 2026 14:02:00 +0000",
                    "Message-ID: <split@example.com>",
                ],
                "Signed body.",
            ),
            signer,
            { signTime: now },
        );

        const facts = await authenticateMessage(raw, { now });

        expect(facts.dkim).toHaveLength(1);
        expect(facts.dkim[0]).toMatchObject({
            domain: "example.com",
            selector: "mail",
            result: "pass",
            comment: "",
        });
    });
});

it("logs complete DKIM diagnostics for a not_signed refusal", () => {
    const log = vi.fn();

    logDkimRefusal(
        "not_signed",
        [
            {
                domain: "example.com",
                selector: "mail",
                result: "neutral",
                comment: "invalid public key",
                signedRecipients: ["recipient@example.org"],
                signedAt: new Date(),
            },
        ],
        log,
    );

    expect(log).toHaveBeenCalledExactlyOnceWith(
        "[mail] refused not_signed: dkim example.com/mail neutral invalid public key",
    );
});
