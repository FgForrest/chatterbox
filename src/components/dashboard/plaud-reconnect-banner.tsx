"use client";

import { AlertTriangle, X } from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { PlaudConnectTabs } from "@/components/plaud-connect-tabs";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { useDateTimeFormatter } from "@/hooks/use-date-time-formatter";
import {
    PLAUD_SESSION_WARNING_WINDOW_MS,
    plaudConnectionBannerState,
} from "@/lib/plaud/connection-expiry";

const ENDING_SOON_DISMISS_KEY = "riffado-plaud-ending-soon-dismissed";
const MAX_CLOCK_TICK_MS = 60 * 60 * 1000;

function msUntilNextBannerChange(
    sessionExpiresAt: string | null,
    now: number,
): number | null {
    if (!sessionExpiresAt) return null;
    const endsAt = new Date(sessionExpiresAt).getTime();
    if (Number.isNaN(endsAt)) return null;
    const next = [endsAt - PLAUD_SESSION_WARNING_WINDOW_MS, endsAt].find(
        (deadline) => deadline > now,
    );
    if (next === undefined) return null;
    return Math.min(next - now, MAX_CLOCK_TICK_MS);
}

interface PlaudReconnectBannerProps {
    show: boolean;
    sessionExpiresAt: string | null;
    connectionUpdatedAt?: string | null;
    onReconnected: () => void;
}

/** Warn before a Plaud sign-in ends and offer the reconnect dialog. */
export function PlaudReconnectBanner({
    show,
    sessionExpiresAt,
    connectionUpdatedAt = null,
    onReconnected,
}: PlaudReconnectBannerProps) {
    const i18n = useExtracted();
    const locale = useLocale();
    const formatDateTime = useDateTimeFormatter();
    const [open, setOpen] = useState(false);
    const [reconnectedFrom, setReconnectedFrom] = useState<{
        sessionExpiresAt: string | null;
        connectionUpdatedAt: string | null;
    } | null>(null);

    const [now, setNow] = useState<number | null>(null);
    useEffect(() => {
        const update = () => setNow(Date.now());
        const onVisibilityChange = () => {
            if (document.visibilityState === "visible") update();
        };
        update();
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () =>
            document.removeEventListener(
                "visibilitychange",
                onVisibilityChange,
            );
    }, []);
    useEffect(() => {
        if (now === null) return;
        const delay = msUntilNextBannerChange(sessionExpiresAt, now);
        if (delay === null) return;
        const timer = window.setTimeout(() => setNow(Date.now()), delay);
        return () => window.clearTimeout(timer);
    }, [sessionExpiresAt, now]);

    const dismissKey = sessionExpiresAt
        ? `${ENDING_SOON_DISMISS_KEY}:${sessionExpiresAt}`
        : null;
    const [dismissedKey, setDismissedKey] = useState<string | null>(null);
    useEffect(() => {
        if (!dismissKey) return;
        try {
            setDismissedKey(
                localStorage.getItem(dismissKey) === "1" ? dismissKey : null,
            );
        } catch {
            setDismissedKey(null);
        }
    }, [dismissKey]);
    const dismissEndingSoon = useCallback(() => {
        if (!dismissKey) return;
        setDismissedKey(dismissKey);
        try {
            localStorage.setItem(dismissKey, "1");
        } catch {
            // The notice remains dismissed for this mount.
        }
    }, [dismissKey]);

    const showingOldSignIn =
        reconnectedFrom !== null &&
        reconnectedFrom.sessionExpiresAt === sessionExpiresAt &&
        reconnectedFrom.connectionUpdatedAt === connectionUpdatedAt;
    const state = plaudConnectionBannerState({
        needsReconnect: show,
        sessionExpiresAt:
            now === null || showingOldSignIn ? null : sessionExpiresAt,
        now: now ?? 0,
    });

    if (!state) return null;
    if (state === "ending-soon" && dismissKey === dismissedKey) return null;

    const endsOn =
        state === "ending-soon" && sessionExpiresAt
            ? formatDateTime(sessionExpiresAt, "absolute", locale)
            : null;

    return (
        <>
            <div className="mb-4 flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-500" />
                    {state === "ending-soon" ? (
                        <div className="space-y-0.5">
                            <p className="text-sm font-medium text-foreground">
                                {i18n("Your Plaud connection ends on {date}", {
                                    date: endsOn ?? "",
                                })}
                            </p>
                            <p className="text-sm text-muted-foreground">
                                {i18n("Reconnect to keep syncing.")}
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-0.5">
                            <p className="text-sm font-medium text-foreground">
                                {i18n(
                                    "Your Plaud connection needs to be reconnected",
                                )}
                            </p>
                            <p className="text-sm text-muted-foreground">
                                {i18n(
                                    "Plaud stopped accepting your saved sign-in, so new recordings aren't syncing. Reconnect to resume — your existing recordings stay put.",
                                )}
                            </p>
                        </div>
                    )}
                </div>
                <div className="flex shrink-0 items-center gap-2 self-start sm:self-auto">
                    <Button onClick={() => setOpen(true)}>
                        {i18n("Reconnect")}
                    </Button>
                    {state === "ending-soon" && (
                        <button
                            type="button"
                            onClick={dismissEndingSoon}
                            className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                            aria-label={i18n(
                                "Dismiss Plaud connection ending notice",
                            )}
                        >
                            <X className="size-4" />
                        </button>
                    )}
                </div>
            </div>

            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle>
                            {i18n("Reconnect your Plaud account")}
                        </DialogTitle>
                        <DialogDescription>
                            {i18n(
                                "Sign back in to resume syncing. Your existing recordings and transcripts are unaffected.",
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    {open && (
                        <PlaudConnectTabs
                            onConnected={() => {
                                setOpen(false);
                                setReconnectedFrom({
                                    sessionExpiresAt,
                                    connectionUpdatedAt,
                                });
                                onReconnected();
                            }}
                        />
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}
