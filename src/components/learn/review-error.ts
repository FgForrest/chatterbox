"use client";

import { useExtracted, useLocale } from "next-intl";
import { parseApiError } from "@/lib/api-errors";
import { normalizeLocale } from "@/lib/i18n/config";

/** Localize API failures without exposing unlocalized provider or server prose. */
export function useLearnApiErrorMessage() {
    const locale = normalizeLocale(useLocale()) ?? "en";
    const i18n = useExtracted();
    return async (response: Response, fallback: string): Promise<string> => {
        const body = await parseApiError(response);
        if (locale === "en") return body.error || fallback;
        switch (body.code) {
            case "AI_PROVIDER_NOT_CONFIGURED":
                return i18n(
                    "Learn needs a chat provider. Add one in Settings → Providers.",
                );
            case "AI_PROVIDER_API_ERROR":
                return i18n(
                    "The provider's answer was not one Learn could use. Try again, or pick another model for Learn in Settings → Providers.",
                );
            case "RATE_LIMITED":
            case "AI_RATE_LIMITED":
                return i18n(
                    "Too many requests. Please wait a moment and try again.",
                );
            default:
                return fallback;
        }
    };
}
