"use client";

import { useExtracted } from "next-intl";
import { GoogleConnectionPanel } from "@/components/integrations/google-connection-panel";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { Button } from "@/components/ui/button";
import {
    useGoogleConnection,
    useGoogleConnectOutcome,
} from "@/hooks/use-google-connection";

export function GoogleAccountSection() {
    const i18n = useExtracted();
    const { state, refresh } = useGoogleConnection();
    useGoogleConnectOutcome(refresh);
    const calendarGranted = state?.connection?.calendarGranted === true;
    const meetGranted = state?.connection?.meetGranted === true;

    return (
        <div className="space-y-4">
            <SettingsSectionHeader
                title={i18n("Google account")}
                description={i18n(
                    "Connect a Google account for Calendar meeting context or Google Drive exports. Each access is requested separately.",
                )}
            />
            <SettingsCard>
                <GoogleConnectionPanel state={state} onChanged={refresh} />
            </SettingsCard>
            {state?.calendarAvailable && (
                <SettingsCard>
                    <div className="space-y-3">
                        <p className="text-sm font-medium">
                            {i18n("Google Calendar for Learn")}
                        </p>
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "Allow Riffado to read events on your primary calendar when you choose a meeting for Learn. Invitees are possible speaker names, not confirmed voice identities.",
                            )}
                        </p>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                                const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
                                window.location.assign(
                                    `/api/integrations/google/connect?purpose=calendar&returnTo=${encodeURIComponent(returnTo)}`,
                                );
                            }}
                        >
                            {calendarGranted
                                ? i18n("Reconnect Calendar")
                                : i18n("Connect Calendar")}
                        </Button>
                    </div>
                </SettingsCard>
            )}
            {state?.meetAvailable && (
                <SettingsCard>
                    <div className="space-y-3">
                        <p className="text-sm font-medium">
                            {i18n("Google Meet for Learn")}
                        </p>
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "Allow Riffado to read who attended a selected Google Meet call. Attendees are possible speaker names, not confirmed voice identities. This uses your connected Google account.",
                            )}
                        </p>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={state.connection?.status !== "active"}
                            onClick={() => {
                                const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
                                window.location.assign(
                                    `/api/integrations/google/connect?purpose=meet&returnTo=${encodeURIComponent(returnTo)}`,
                                );
                            }}
                        >
                            {meetGranted
                                ? i18n("Reconnect Meet")
                                : i18n("Connect Meet")}
                        </Button>
                    </div>
                </SettingsCard>
            )}
        </div>
    );
}
