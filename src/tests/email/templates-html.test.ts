/**
 * The HTML every email template renders, kept as files: a change to the
 * markup (a component, a style, a template) shows as a diff of what
 * recipients' mail clients get.
 */

import path from "node:path";
import React from "react";
import { describe, expect, it } from "vitest";
import { AccountDeletedEmail } from "@/lib/notifications/email-templates/account-deleted";
import { EmailChangeConfirmEmail } from "@/lib/notifications/email-templates/email-change-confirm";
import { ExportReadyEmail } from "@/lib/notifications/email-templates/export-ready";
import { GraceLastDayEmail } from "@/lib/notifications/email-templates/grace-last-day";
import { GraceReminderEmail } from "@/lib/notifications/email-templates/grace-reminder";
import { GraceStartedEmail } from "@/lib/notifications/email-templates/grace-started";
import { NewRecordingEmail } from "@/lib/notifications/email-templates/new-recording-email";
import { NewsletterConfirmEmail } from "@/lib/notifications/email-templates/newsletter-confirm-email";
import { OverCapEmail } from "@/lib/notifications/email-templates/over-cap";
import { PasswordResetEmail } from "@/lib/notifications/email-templates/password-reset-email";
import { PaymentFailedEmail } from "@/lib/notifications/email-templates/payment-failed";
import { RebrandAnnouncementEmail } from "@/lib/notifications/email-templates/rebrand-announcement-email";
import { TestEmail } from "@/lib/notifications/email-templates/test-email";
import { TransitionEndedEmail } from "@/lib/notifications/email-templates/transition-ended";
import { TransitionReminderEmail } from "@/lib/notifications/email-templates/transition-reminder";
import { TransitionStartEmail } from "@/lib/notifications/email-templates/transition-start";
import { VerifyEmailEmail } from "@/lib/notifications/email-templates/verify-email";
import { WelcomeHostedProEmail } from "@/lib/notifications/email-templates/welcome-hosted-pro";
import { renderEmailHtml } from "@/lib/notifications/render-email";

const at = new Date("2026-08-27T12:00:00Z");
const app = "https://app.example.test";

const templates: Record<string, React.ReactElement> = {
    "account-deleted": React.createElement(AccountDeletedEmail, {
        signupUrl: `${app}/signup`,
    }),
    "email-change-confirm": React.createElement(EmailChangeConfirmEmail, {
        confirmUrl: `${app}/confirm?t=1`,
        newEmail: "new@example.test",
        expiresInHours: 24,
    }),
    "export-ready": React.createElement(ExportReadyEmail, {
        downloadUrl: `${app}/export/1`,
    }),
    "grace-last-day": React.createElement(GraceLastDayEmail, {
        deletionAt: at,
        exportUrl: `${app}/settings#export`,
        reactivateUrl: `${app}/settings#billing`,
    }),
    "grace-reminder": React.createElement(GraceReminderEmail, {
        daysLeft: 3,
        deletionAt: at,
        exportUrl: `${app}/settings#export`,
        reactivateUrl: `${app}/settings#billing`,
    }),
    "grace-started": React.createElement(GraceStartedEmail, {
        gracePath: "paid",
        graceDays: 30,
        trialDays: 14,
        deletionAt: at,
        exportUrl: `${app}/settings#export`,
        reactivateUrl: `${app}/settings#billing`,
    }),
    "new-recording": React.createElement(NewRecordingEmail, {
        count: 2,
        recordingNames: ["Weekly sync", "Call with Eva"],
        dashboardUrl: `${app}/dashboard`,
        settingsUrl: `${app}/settings`,
    }),
    "newsletter-confirm": React.createElement(NewsletterConfirmEmail, {
        confirmUrl: `${app}/newsletter/confirm?t=1`,
    }),
    "over-cap": React.createElement(OverCapEmail, {
        billingUrl: `${app}/settings#billing`,
        settingsUrl: `${app}/settings`,
        currentBytes: 6 * 1024 ** 3,
        limitBytes: 5 * 1024 ** 3,
    }),
    "password-reset": React.createElement(PasswordResetEmail, {
        resetUrl: `${app}/reset?t=1`,
    }),
    "payment-failed": React.createElement(PaymentFailedEmail, {
        billingUrl: `${app}/settings#billing`,
        nextRetryAt: at,
        accessUntil: new Date("2026-09-10T12:00:00Z"),
    }),
    "rebrand-announcement": React.createElement(RebrandAnnouncementEmail, {
        recipientName: "Eva",
        rebrandUrl: `${app}/rebrand`,
        loginUrl: `${app}/login`,
        unsubscribeUrl: `${app}/unsubscribe?t=1`,
    }),
    test: React.createElement(TestEmail, {
        dashboardUrl: `${app}/dashboard`,
        settingsUrl: `${app}/settings`,
    }),
    "transition-ended": React.createElement(TransitionEndedEmail, {
        amountValue: "5.00",
        amountCurrency: "EUR",
        billingUrl: `${app}/settings#billing`,
        exportUrl: `${app}/settings#export`,
        selfHostUrl: `${app}/self-host`,
    }),
    "transition-reminder": React.createElement(TransitionReminderEmail, {
        daysLeft: 5,
        transitionEndsAt: at,
        amountValue: "5.00",
        amountCurrency: "EUR",
        foundingOfferAvailable: true,
        foundingCapacity: 100,
        billingUrl: `${app}/settings#billing`,
        exportUrl: `${app}/settings#export`,
        selfHostUrl: `${app}/self-host`,
    }),
    "transition-start": React.createElement(TransitionStartEmail, {
        transitionEndsAt: at,
        amountValue: "5.00",
        amountCurrency: "EUR",
        foundingOfferAvailable: false,
        foundingCapacity: 100,
        billingUrl: `${app}/settings#billing`,
        exportUrl: `${app}/settings#export`,
        selfHostUrl: `${app}/self-host`,
    }),
    "verify-email": React.createElement(VerifyEmailEmail, {
        verificationUrl: `${app}/verify?t=1`,
        expiresInHours: 24,
    }),
    "welcome-hosted-pro": React.createElement(WelcomeHostedProEmail, {
        dashboardUrl: `${app}/dashboard`,
        settingsUrl: `${app}/settings`,
        foundingMember: true,
        foundingRank: 47,
        foundingCapacity: 100,
        amountValue: "5.00",
        amountCurrency: "EUR",
        interval: "month",
        recordingCount: 12,
        totalDurationMs: 5 * 3600 * 1000,
    }),
};

describe("email templates' HTML", () => {
    for (const [name, element] of Object.entries(templates)) {
        for (const locale of ["en", "cs-CZ"] as const) {
            it(`${name} (${locale})`, async () => {
                const html = await renderEmailHtml(element, locale);
                await expect(html).toMatchFileSnapshot(
                    path.join(
                        __dirname,
                        "__snapshots__",
                        "templates",
                        `${name}.${locale}.html`,
                    ),
                );
            });
        }
    }
});
