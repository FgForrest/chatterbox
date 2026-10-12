// @vitest-environment jsdom

/**
 * The formatted mail as the browser sanitizes it before an empty-`sandbox`
 * frame shows it: DOMPurify with the mail rules runs nothing, fetches
 * nothing, keeps a mail's formatting, and refuses to hand back HTML where
 * it cannot run.
 */

import createDOMPurify, { type WindowLike } from "dompurify";
import { describe, expect, it } from "vitest";
import {
    createMailPurifier,
    MAIL_CSP,
    mailHtmlDocument,
} from "@/lib/mail/mail-html-document";

const purifier = createMailPurifier(window);

function sanitized(html: string): string {
    const framed = mailHtmlDocument(html, purifier);
    if (framed === null) throw new Error("DOMPurify did not run");
    const body = /<body>([\s\S]*)<\/body><\/html>$/.exec(framed)?.[1];
    if (body === undefined) throw new Error("no body in the document");
    return body;
}

describe("formatted mail", () => {
    it("runs nothing and fetches nothing", () => {
        const out = sanitized(
            [
                '<p onclick="steal()">Hello <b>there</b></p>',
                "<script>steal()</script>",
                '<img src="https://tracker.example/pixel.gif">',
                '<div style="background:url(https://tracker.example/bg); color:red">styled</div>',
                '<a href="javascript:steal()">bad link</a>',
                '<a href="https://example.com/doc">good link</a>',
                "<style>body{background:url(https://tracker.example/x)}</style>",
                '<iframe src="https://example.com"></iframe>',
                '<form action="https://example.com"><input name="x"></form>',
            ].join(""),
        );
        expect(out).toContain("<b>there</b>");
        expect(out).not.toMatch(
            /onclick|<script|steal\(\)|<iframe|<form|<input|<style/i,
        );
        expect(out).not.toContain("tracker.example");
        expect(out).toContain('style="color:red"');
        expect(out).toContain('href="https://example.com/doc"');
        expect(out).not.toContain("javascript:");
    });

    it("wraps the body in a document whose CSP allows nothing else", () => {
        const framed = mailHtmlDocument("<p>Hi</p>", purifier) ?? "";
        expect(framed).toContain(
            `<meta http-equiv="Content-Security-Policy" content="${MAIL_CSP}">`,
        );
        expect(MAIL_CSP).toContain("default-src 'none'; img-src data:");
    });

    it("keeps links to the web, mail and the mail itself, nothing else", () => {
        const out = sanitized(
            [
                '<a href="mailto:jan@company.example">mail</a>',
                '<a href="#top">top</a>',
                '<a href="data:text/html,<b>x</b>">data</a>',
                '<a href="//evil.example/x">protocol-relative</a>',
                '<a href="\\\\evil.example/x">backslashes</a>',
                '<a href=" &#106;avascript:steal()">entity</a>',
                '<a href="vbscript:x">vbscript</a>',
                '<a href="https://example.com" target="_blank" data-x="1">blank</a>',
            ].join(""),
        );
        expect(out).toContain('href="mailto:jan@company.example"');
        expect(out).toContain('href="#top"');
        const hrefs = [...out.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
        expect(hrefs).toEqual([
            "mailto:jan@company.example",
            "#top",
            "https://example.com",
        ]);
        expect(out).not.toMatch(/target=|data-x/);
        expect(out).toContain('rel="noopener noreferrer nofollow"');
    });

    it("shows images only from the mail itself", () => {
        const png =
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        const out = sanitized(
            [
                `<img src="${png}" alt="logo" width="10">`,
                '<img src="http://tracker.example/p.gif">',
                '<img src="logo.png">',
                '<img src="data:text/html,x">',
            ].join(""),
        );
        expect(out).toContain(`src="${png}"`);
        expect(out).toContain('alt="logo"');
        expect(out).not.toMatch(/tracker\.example|logo\.png|data:text/);
    });

    it("keeps known style properties whose values fetch nothing", () => {
        const out = sanitized(
            [
                '<p style="color: red; position: fixed; font-weight: bold">a</p>',
                '<p style="background-color: image-set(url(x.png) 1x)">b</p>',
                '<p style="width: expression(alert(1))">c</p>',
                '<p style="color: \\72 ed">d</p>',
                "<p style=\"font-family: 'A;B', serif; margin: 0 auto\">e</p>",
                '<p style="border: 1px solid #ccc; @import url(x)">f</p>',
            ].join(""),
        );
        expect(out).toContain('style="color:red;font-weight:bold"');
        expect(out).not.toMatch(/position|image-set|expression|\\72|@import/);
        expect(out).toContain(
            "style=\"font-family:'A;B', serif;margin:0 auto\"",
        );
        expect(out).toContain('style="border:1px solid #ccc"');
    });

    it("keeps a mail's layout: tables, fonts, centered blocks", () => {
        const out = sanitized(
            [
                '<table border="0" cellpadding="4" cellspacing="0" width="600" bgcolor="#fff">',
                '<tr><td colspan="2" align="center" valign="top">cell</td></tr>',
                "</table>",
                '<font face="Arial" size="2" color="#333">font</font>',
                "<center>centered</center>",
                '<ol start="3" type="a"><li>three</li></ol>',
            ].join(""),
        );
        expect(out).toMatch(/<table[^>]*cellpadding="4"/);
        expect(out).toContain('colspan="2"');
        expect(out).toContain('<font face="Arial" size="2" color="#333">');
        expect(out).toContain("<center>centered</center>");
        expect(out).toContain('<ol start="3" type="a">');
    });

    it("drops SVG, MathML and their tricks", () => {
        const out = sanitized(
            [
                '<svg><foreignObject><img src="x" onerror="steal()"></foreignObject></svg>',
                '<math><mi xlink:href="javascript:steal()">x</mi></math>',
                '<noscript><p title="</noscript><img src=x onerror=steal()>"></p></noscript>',
                '<p id="cookie" name="x">clobber</p>',
            ].join(""),
        );
        expect(out).not.toMatch(/<svg|<math|foreignobject|onerror|steal/i);
        expect(out).not.toContain('id="cookie"');
    });

    it("returns nothing where DOMPurify cannot run, rather than the HTML", () => {
        const unsupported = createDOMPurify({} as WindowLike);
        expect(unsupported.isSupported).toBe(false);
        expect(
            mailHtmlDocument("<img src=x onerror=steal()>", unsupported),
        ).toBeNull();
        expect(mailHtmlDocument("<p>x</p>", null)).toBeNull();
    });
});
