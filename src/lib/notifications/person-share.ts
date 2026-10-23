import { and, eq } from "drizzle-orm";
import { getExtracted } from "next-intl/server";
import { db } from "@/db";
import { userSettings, users } from "@/db/schema";
import { env } from "@/lib/env";
import { normalizeLocale } from "@/lib/i18n/config";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import { sendEmail } from "@/lib/notifications/email";

/** Best-effort invitation email, only for recipients who enabled email notifications. */
export async function sendPersonShareInvitation(userId: string): Promise<void> {
    const [recipient] = await db
        .select({
            email: users.email,
            locale: users.uiLocale,
            notificationEmail: userSettings.notificationEmail,
        })
        .from(users)
        .innerJoin(userSettings, eq(userSettings.userId, users.id))
        .where(
            and(
                eq(users.id, userId),
                eq(userSettings.emailNotifications, true),
            ),
        )
        .limit(1);
    if (!recipient) return;
    const locale = normalizeLocale(recipient.locale) ?? "en";
    const subject = translatedSourceMessage(
        locale,
        "A colleague shared an item with you.",
    );
    const label = translatedSourceMessage(locale, "Review invitations");
    const url = new URL("/dashboard?invitations=1", env.APP_URL)
        .toString()
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            sendEmail({
                to: recipient.notificationEmail || recipient.email,
                subject,
                html: `<p>${subject}</p><p><a href="${url}">${label}</a></p>`,
            }),
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 3000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** Keeps invitation email copy in the source-message catalogs. */
export async function extractPersonShareEmailMessages(): Promise<void> {
    const i18n = await getExtracted();
    i18n("A colleague shared an item with you.");
    i18n("Review invitations");
}
