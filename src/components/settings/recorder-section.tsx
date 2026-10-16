"use client";

import { Video } from "lucide-react";
import { useExtracted } from "next-intl";
import { MeetingRecorderSetup } from "@/components/meeting-recorder-setup";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { RECORDER_EXTENSION_STORE_URL } from "@/lib/recorder-extension/extension-id";

/** Meeting Recorder settings section. */
export function RecorderSection() {
    const i18n = useExtracted();
    return (
        <div className="space-y-6">
            <SettingsSectionHeader
                title={i18n("Meeting Recorder")}
                description={i18n(
                    "Record browser meetings and send them to your Chatterbox library.",
                )}
                icon={Video}
            />
            <SettingsCard>
                <MeetingRecorderSetup
                    mode="settings"
                    storeUrl={RECORDER_EXTENSION_STORE_URL}
                />
            </SettingsCard>
        </div>
    );
}
