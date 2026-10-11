import { describe, expect, it } from "vitest";
import { mailHtmlBody } from "@/lib/mail/html-view";

function multipart(html: string, image?: { cid: string; png: Buffer }): Buffer {
    const parts = [
        "From: jan@company.example",
        "To: jan@klepna.example",
        "Subject: Formatted",
        "MIME-Version: 1.0",
        'Content-Type: multipart/related; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/html; charset=utf-8",
        "",
        html,
    ];
    if (image) {
        parts.push(
            "--b1",
            "Content-Type: image/png",
            "Content-Transfer-Encoding: base64",
            `Content-ID: <${image.cid}>`,
            "Content-Disposition: inline",
            "",
            image.png.toString("base64"),
        );
    }
    parts.push("--b1--", "");
    return Buffer.from(parts.join("\r\n"));
}

describe("a mail's HTML for the browser", () => {
    it("inlines cid: images as data URIs", async () => {
        const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
            "base64",
        );
        const html = await mailHtmlBody(
            multipart('<p>Logo: <img src="cid:logo@company.example"></p>', {
                cid: "logo@company.example",
                png,
            }),
        );
        expect(html).toContain('src="data:image/png;base64,');
        expect(html).not.toContain("cid:");
    });

    it("empties a cid: reference the mail does not carry", async () => {
        const html = await mailHtmlBody(
            multipart('<p><img src="cid:missing@company.example"></p>'),
        );
        expect(html).toContain('src=""');
    });

    it("has nothing to show for a plain-text mail", async () => {
        const raw = Buffer.from(
            "From: a@company.example\r\nSubject: x\r\n\r\nJust text\r\n",
        );
        expect(await mailHtmlBody(raw)).toBeNull();
    });
});
