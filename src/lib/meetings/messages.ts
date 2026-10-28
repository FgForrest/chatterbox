import { getExtracted } from "next-intl/server";
import type { AppLocale } from "@/lib/i18n/config";
import { translatedSourceMessage } from "@/lib/i18n/messages";

const messages = {
    contextTooLarge:
        "AI suggestions support up to 100 summaries, 200 open tasks and 160,000 characters. Reduce the agenda context.",
    recordingAudience:
        "This recording is shared with people who cannot see the agenda. Limit its sharing before attaching it.",
    invalidResponse:
        "The provider returned invalid agenda suggestions. Try again.",
} as const;

/** Translate background meeting errors through the shared server message catalog. */
export function meetingPipelineMessage(
    locale: AppLocale,
    kind: keyof typeof messages,
): string {
    return translatedSourceMessage(locale, messages[kind]);
}

/** Keep background meeting copy in next-intl's extracted catalogs. */
export async function extractMeetingPipelineMessages(): Promise<void> {
    const i18n = await getExtracted();
    i18n(
        "AI suggestions support up to 100 summaries, 200 open tasks and 160,000 characters. Reduce the agenda context.",
    );
    i18n(
        "This recording is shared with people who cannot see the agenda. Limit its sharing before attaching it.",
    );
    i18n("The provider returned invalid agenda suggestions. Try again.");
}
