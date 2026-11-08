"use client";

import { useExtracted } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { usePersonSharing } from "@/components/sharing/person-sharing";
import { Button } from "@/components/ui/button";
import { useAgendaRecordingPrivacy } from "@/hooks/use-library-preferences";
import { subscribeEvents } from "@/lib/events/client";
import { meetingRequest, meetingUrl } from "./api";

/** Recording owners explicitly bridge agenda access to ordinary recording invitations. */
export function RecordingShareBanner({
    agendaId,
    title,
    recordingId,
    userId,
}: {
    agendaId: string;
    title: string;
    recordingId: string;
    userId: string | undefined;
}) {
    const i18n = useExtracted();
    const enabled = usePersonSharing();
    const privacy = useAgendaRecordingPrivacy(userId, recordingId);
    const [people, setPeople] = useState<{ id: string; name: string | null }[]>(
        [],
    );
    const [busy, setBusy] = useState(false);
    const load = useCallback(async () => {
        const result = await meetingRequest<{ people: typeof people }>(
            meetingUrl(
                agendaId,
                `/recording-shares?recordingItemId=${encodeURIComponent(recordingId)}`,
            ),
        );
        setPeople(result.people);
    }, [agendaId, recordingId]);
    useEffect(() => {
        if (!enabled) return;
        void load().catch(() => {});
        return subscribeEvents((event) => {
            if (event.type === "share") void load().catch(() => {});
        });
    }, [enabled, load]);
    if (!enabled || !privacy.ready || privacy.dismissed || !people.length)
        return null;
    return (
        <div className="space-y-2 rounded-lg border border-person-share/30 bg-person-share/10 p-3 text-sm">
            <p>
                {i18n(
                    "You share the agenda “{title}” with these people: {names}. The recording is not shared with them yet.",
                    {
                        title,
                        names: people
                            .map((person) => person.name ?? i18n("Someone"))
                            .join(", "),
                    },
                )}
            </p>
            <Button
                size="sm"
                disabled={busy}
                onClick={async () => {
                    setBusy(true);
                    try {
                        await meetingRequest(
                            meetingUrl(agendaId, "/recording-shares"),
                            "POST",
                            { recordingItemId: recordingId },
                        );
                        await load();
                    } catch {
                        toast.error(i18n("Could not update sharing"));
                    } finally {
                        setBusy(false);
                    }
                }}
            >
                {i18n("Invite them to the recording too")}
            </Button>
            <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={privacy.dismiss}
            >
                {i18n("Keep private")}
            </Button>
        </div>
    );
}
