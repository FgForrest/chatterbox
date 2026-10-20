import { getExtracted } from "next-intl/server";

/** Keeps background Learn review copy in next-intl's extracted catalogs. */
export async function extractLearnReviewMessages(): Promise<void> {
    const i18n = await getExtracted();
    i18n("Another address of a known person");
    i18n("A participant of the mail");
}
