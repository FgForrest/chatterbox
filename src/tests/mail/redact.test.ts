import { describe, expect, it, vi } from "vitest";

const { resolveLocalPartMock } = vi.hoisted(() => ({
    resolveLocalPartMock: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: { MAIL_DOMAIN: undefined } }));
vi.mock("@/lib/mail/addresses", () => ({
    resolveLocalPart: resolveLocalPartMock,
}));

import {
    secretAddressMasker,
    secretAddressMaskerForHtml,
} from "@/lib/mail/redact";

describe("mail redaction without inbound mail", () => {
    it("leaves plain text and HTML unchanged when MAIL_DOMAIN is unset", async () => {
        const plain = "Send this to jan.secret@example.test";
        const html =
            '<a href="mailto:jan%2Esecret%40example.test">jan&#46;secret&#64;example.test</a>';

        expect((await secretAddressMasker([plain]))(plain)).toBe(plain);
        expect((await secretAddressMaskerForHtml(html))(html)).toBe(html);
        expect(resolveLocalPartMock).not.toHaveBeenCalled();
    });
});
