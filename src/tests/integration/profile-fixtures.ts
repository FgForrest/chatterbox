import { ensureProfiles } from "@/lib/profiles/seed";

/** Seed the personal defaults that an account created before Organization defaults already owns. */
export async function seedExistingPersonalProfiles(
    userId: string,
    testEnv: { SELF_HOST_MODE: string },
): Promise<void> {
    const previousMode = testEnv.SELF_HOST_MODE;
    testEnv.SELF_HOST_MODE = "local";
    try {
        await ensureProfiles(userId);
    } finally {
        testEnv.SELF_HOST_MODE = previousMode;
    }
}
