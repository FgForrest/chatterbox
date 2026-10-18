// @vitest-environment jsdom

import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: { APP_URL: "https://example.test", IS_HOSTED: false },
}));

import { defaultLocale } from "@/lib/i18n/config";
import { TestEmail } from "@/lib/notifications/email-templates/test-email";
import { TransitionStartEmail } from "@/lib/notifications/email-templates/transition-start";
import { renderEmailHtml } from "@/lib/notifications/render-email";
import { plainTextOf } from "@/tests/email/plain-text";

const baseProps = {
    transitionEndsAt: new Date("2026-08-27T23:59:59Z"),
    amountValue: "5.00",
    amountCurrency: "USD",
    foundingCapacity: 100,
    billingUrl: "https://riffado.com/settings#billing",
    exportUrl: "https://riffado.com/settings#export",
    selfHostUrl: "https://github.com/riffado/riffado#quick-start",
};

async function renderTransition(
    props: React.ComponentProps<typeof TransitionStartEmail>,
) {
    return plainTextOf(
        await renderEmailHtml(
            React.createElement(TransitionStartEmail, props),
            defaultLocale,
        ),
    );
}

describe("TransitionStartEmail", () => {
    it("states the capacity rule without guaranteeing a founding spot", async () => {
        const text = await renderTransition({
            ...baseProps,
            foundingOfferAvailable: true,
        });
        expect(text).toContain("first 100 paid monthly members");
        expect(text).toContain("first-paid, first-served");
        expect(text).toContain("Claim founding price");
        expect(text).toContain("your account becomes read-only");
        expect(text).toContain("Nothing gets deleted");
        expect(text).not.toContain("Add a card before then");
        expect(text).toContain(
            "https://github.com/riffado/riffado#quick-start",
        );
    });

    it("shows standard pricing after founding capacity is gone", async () => {
        const text = await renderTransition({
            ...baseProps,
            amountValue: "9.00",
            foundingOfferAvailable: false,
        });
        expect(text).toContain("Monthly Hosted Pro is available for $9");
        expect(text).toContain("Choose a plan");
        expect(text).not.toContain("first 100 paid monthly members");
    });

    it("draws its bullets as bullets, not as the text of their entity", async () => {
        const text = await renderTransition({
            ...baseProps,
            foundingOfferAvailable: true,
        });
        expect(text).not.toContain("&bull;");
        expect(text).toMatch(/•\s*You keep full free access until/);
    });

    it("explains why hosted is now paid, not just what changed", async () => {
        const text = await renderTransition({
            ...baseProps,
            foundingOfferAvailable: true,
        });
        expect(text).toContain("real infrastructure");
        expect(text).toContain("no lock-in");
        expect(text).toContain("Self-host and Hosted Pro are the same project");
    });

    it("gives account-critical facts their own scannable section", async () => {
        const text = await renderTransition({
            ...baseProps,
            foundingOfferAvailable: true,
        });
        expect(text.toLowerCase()).toContain(
            "what this means for your account",
        );
        expect(text).toContain("grace period");
    });

    it("states the founding-capacity qualifier in the top summary too, not only in the full account section", async () => {
        const text = await renderTransition({
            ...baseProps,
            foundingOfferAvailable: true,
        });
        const inShortSection = text.split("In short")[1]?.split("---")[0] ?? "";
        // A skimmer who only reads the top summary must not be able to read
        // it as a guaranteed founding price -- the first-paid/first-served
        // capacity limit has to be there, not only in the fuller section
        // below that a skimmer may never reach.
        expect(inShortSection).toContain("first 100 paid monthly members");
        expect(inShortSection).toContain("first-paid, first-served");
    });

    it("renders localized email outside a React internationalization context", async () => {
        const html = await renderEmailHtml(
            React.createElement(TestEmail, {
                dashboardUrl: "https://example.test",
                settingsUrl: "https://example.test/settings",
            }),
            "cs-CZ",
        );

        expect(html).toContain("Testovací e-mail");
        expect(html).toContain("e-mailová upozornění fungují");
        expect(html).toContain("Klepna");
        expect(html).not.toContain("Riffado");
    });
});
