import type { userSettings } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import type {
    AudioProfileSettings,
    MailProfileSettings,
} from "@/lib/profiles/settings";

type SummaryStep =
    | AudioProfileSettings["steps"]["summary"]
    | MailProfileSettings["steps"]["summary"];

type SettingsRow = Pick<
    typeof userSettings.$inferSelect,
    | "summaryMultiPass"
    | "summaryMultiPassAuto"
    | "summaryMultiPassRounds"
    | "summaryMergePrompt"
>;

export interface MultiPassResolution {
    enabled: boolean;
    source: "profile" | "person" | "off";
    config: { rounds: number | null; mergePrompt: string | null } | null;
}

/** Resolve whether a summary uses multi-pass and which rounds and merge prompt apply. */
export function resolveMultiPass(input: {
    profileSummary: SummaryStep | null;
    hasProfile: boolean;
    actorSettings: SettingsRow | undefined;
    settings: SettingsRow | undefined;
    trigger: "manual" | "auto" | undefined;
}): MultiPassResolution {
    const pinned = input.profileSummary?.provider
        ? input.profileSummary.multiPass
        : null;
    const enabled = pinned
        ? pinned.enabled && (input.trigger !== "auto" || pinned.automaticToo)
        : input.actorSettings?.summaryMultiPass === true &&
          (input.trigger !== "auto" ||
              input.actorSettings.summaryMultiPassAuto);
    if (!enabled) return { enabled: false, source: "off", config: null };

    const mergeSettings = input.hasProfile
        ? input.actorSettings
        : input.settings;
    return {
        enabled: true,
        source: pinned ? "profile" : "person",
        config: {
            rounds:
                pinned?.rounds ??
                input.actorSettings?.summaryMultiPassRounds ??
                null,
            mergePrompt: pinned
                ? pinned.mergePrompt
                : mergeSettings?.summaryMergePrompt
                  ? (decryptText(mergeSettings.summaryMergePrompt) ?? null)
                  : null,
        },
    };
}
