import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { getSession } from "@/lib/auth-server";
import { localeFromAcceptLanguage, normalizeLocale } from "@/lib/i18n/config";
import { messagesForLocale } from "@/lib/i18n/messages";
import { TIME_ZONE_COOKIE } from "@/lib/i18n/time-zone";
import { userTimeZone } from "@/lib/i18n/user-time-zone";

export default getRequestConfig(async () => {
    const [session, requestHeaders, requestCookies] = await Promise.all([
        getSession(),
        headers(),
        cookies(),
    ]);
    const locale =
        normalizeLocale(session?.user.uiLocale) ??
        localeFromAcceptLanguage(requestHeaders.get("accept-language"));

    return {
        locale,
        timeZone: await userTimeZone(
            session?.user.id,
            requestCookies.get(TIME_ZONE_COOKIE)?.value,
        ),
        messages: messagesForLocale(locale),
    };
});
