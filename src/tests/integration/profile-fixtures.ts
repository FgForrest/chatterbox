import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { processingProfileRevisions, processingProfiles } from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { ensureProfiles } from "@/lib/profiles/seed";
import { parseProfileSettings } from "@/lib/profiles/settings";

/** Seed the personal defaults that an account created before Organization defaults already owns. */
export async function seedExistingPersonalProfiles(
    userId: string,
    testEnv: { SELF_HOST_MODE: string },
    options: { trim: boolean } = { trim: false },
): Promise<void> {
    const previousMode = testEnv.SELF_HOST_MODE;
    testEnv.SELF_HOST_MODE = "local";
    try {
        await ensureProfiles(userId);
        const revisions = await db
            .select({
                id: processingProfileRevisions.id,
                settings: processingProfileRevisions.settings,
            })
            .from(processingProfileRevisions)
            .innerJoin(
                processingProfiles,
                eq(processingProfiles.id, processingProfileRevisions.profileId),
            )
            .where(
                and(
                    eq(processingProfiles.ownerUserId, userId),
                    eq(processingProfiles.channel, "audio"),
                ),
            );
        for (const revision of revisions) {
            const settings = parseProfileSettings(
                "audio",
                JSON.parse(decryptText(revision.settings)),
            );
            settings.steps.trim.automatic = options.trim;
            await db
                .update(processingProfileRevisions)
                .set({ settings: encryptText(JSON.stringify(settings)) })
                .where(
                    and(
                        eq(processingProfileRevisions.id, revision.id),
                        inArray(
                            processingProfileRevisions.profileId,
                            db
                                .select({ id: processingProfiles.id })
                                .from(processingProfiles)
                                .where(
                                    and(
                                        eq(
                                            processingProfiles.ownerUserId,
                                            userId,
                                        ),
                                        eq(
                                            processingProfiles.currentRevisionId,
                                            revision.id,
                                        ),
                                    ),
                                ),
                        ),
                    ),
                );
        }
    } finally {
        testEnv.SELF_HOST_MODE = previousMode;
    }
}
