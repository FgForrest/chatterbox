"use client";

import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { clearSsoReturnPath, loginReturnPath } from "@/lib/auth/return-path";
import { observeSessionExpiry } from "@/lib/auth/session-expiry";
import { authClient } from "@/lib/auth-client";

const MAX_TIMER_DELAY = 2_147_483_647;
const CHECK_THROTTLE = 60_000;
const SKEW_RETRY_DELAYS = [30_000, 60_000, 120_000];

/** Watch a signed-in page for confirmed session expiry and offer a return to sign-in. */
export function SessionWatcher({ expiresAt }: { expiresAt: string }) {
    const i18n = useExtracted();
    const [open, setOpen] = useState(false);
    const [loginUrl, setLoginUrl] = useState("/login");

    useEffect(() => {
        let active = true;
        let checking = false;
        let lastCheck = -Infinity;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let expirySignal = 0;
        let skewRetries = 0;

        clearSsoReturnPath();
        setOpen(false);
        const showExpiry = () => {
            expirySignal++;
            const returnPath = loginReturnPath(
                `${window.location.pathname}${window.location.search}${window.location.hash}`,
            );
            setLoginUrl(`/login?returnTo=${encodeURIComponent(returnPath)}`);
            setOpen(true);
        };

        const schedule = (deadline: number) => {
            clearTimeout(timer);
            if (!Number.isFinite(deadline)) return;
            const delay = Math.max(0, deadline - Date.now());
            timer = setTimeout(
                () => {
                    if (deadline > Date.now()) schedule(deadline);
                    else void check();
                },
                Math.min(delay, MAX_TIMER_DELAY),
            );
        };

        const check = async () => {
            if (checking) return;
            checking = true;
            lastCheck = Date.now();
            const signal = expirySignal;
            try {
                const result = await authClient.getSession({
                    query: { disableCookieCache: true },
                });
                if (!active || result.error || signal !== expirySignal) return;
                if (result.data === null) {
                    clearTimeout(timer);
                    showExpiry();
                } else if (result.data?.session) {
                    setOpen(false);
                    const deadline = new Date(
                        result.data.session.expiresAt,
                    ).getTime();
                    clearTimeout(timer);
                    if (deadline > Date.now()) {
                        skewRetries = 0;
                        schedule(deadline);
                    } else if (Number.isFinite(deadline)) {
                        const delay = SKEW_RETRY_DELAYS[skewRetries++];
                        if (delay !== undefined) schedule(Date.now() + delay);
                    }
                }
            } catch {
            } finally {
                checking = false;
            }
        };

        const recheck = () => {
            if (Date.now() - lastCheck >= CHECK_THROTTLE) void check();
        };
        const onVisible = () => {
            if (document.visibilityState === "visible") recheck();
        };

        const stopObserving = observeSessionExpiry(showExpiry);
        schedule(Date.parse(expiresAt));
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("online", recheck);
        return () => {
            active = false;
            clearTimeout(timer);
            stopObserving();
            document.removeEventListener("visibilitychange", onVisible);
            window.removeEventListener("online", recheck);
        };
    }, [expiresAt]);

    return (
        <AlertDialog open={open} onOpenChange={setOpen}>
            <AlertDialogContent
                className="z-[1000000000]"
                overlayClassName="z-[1000000000]"
            >
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        {i18n("Your sign-in has expired")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {i18n(
                            "Sign in again to continue. Unsaved edits on this page may be lost.",
                        )}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>{i18n("Later")}</AlertDialogCancel>
                    <AlertDialogAction asChild>
                        <a href={loginUrl}>{i18n("Sign in again")}</a>
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
