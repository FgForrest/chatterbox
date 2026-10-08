"use client";

import {
    AlertCircle,
    CircleHelp,
    Keyboard,
    LogOut,
    Menu,
    Monitor,
    Moon,
    RefreshCw,
    Settings,
    Shield,
    Sun,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useExtracted, useLocale } from "next-intl";
import posthog from "posthog-js";
import { useHelp } from "@/components/help/help-provider";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/hooks/use-theme";
import { signOut } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

interface UserMenuProps {
    isAdmin: boolean;
    initialTheme: "light" | "dark" | "system";
    userEmail: string | null;
    onOpenSettings: () => void;
    onOpenShortcuts: () => void;
    lastSyncTime: Date | null;
    nextSyncTime: Date | null;
    isAutoSyncing: boolean;
    lastSyncResult: { success: boolean; error?: string } | null;
    onSync: () => void;
}

function Kbd({ children }: { children: React.ReactNode }) {
    return (
        <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
            {children}
        </kbd>
    );
}

function emailInitial(email: string | null): string {
    if (!email) return "?";
    const trimmed = email.trim();
    if (!trimmed) return "?";
    return trimmed[0].toUpperCase();
}

export function UserMenu({
    isAdmin,
    initialTheme,
    userEmail,
    onOpenSettings,
    onOpenShortcuts,
    lastSyncTime,
    nextSyncTime,
    isAutoSyncing,
    lastSyncResult,
    onSync,
}: UserMenuProps) {
    const i18n = useExtracted();
    const locale = useLocale();
    const { push, refresh } = useRouter();
    const { openHelp } = useHelp();
    const { theme, setTheme } = useTheme(initialTheme);
    const syncFailed = !isAutoSyncing && lastSyncResult?.success === false;

    const themeOptions = [
        { value: "light" as const, label: i18n("Light"), icon: Sun },
        { value: "dark" as const, label: i18n("Dark"), icon: Moon },
        { value: "system" as const, label: i18n("Auto"), icon: Monitor },
    ];

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="outline"
                    size="icon"
                    aria-label={i18n("Account menu")}
                >
                    <Menu className="size-5" aria-hidden="true" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72 p-0">
                <div className="flex items-center gap-3 border-b p-3">
                    <div
                        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
                        aria-hidden="true"
                    >
                        {emailInitial(userEmail)}
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                            {userEmail || i18n("Signed in")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {isAdmin ? i18n("Admin") : i18n("Signed in")}
                        </p>
                    </div>
                </div>

                <div className="p-1">
                    <DropdownMenuItem onSelect={onOpenSettings}>
                        <Settings />
                        <span className="flex-1">{i18n("Settings")}</span>
                        <Kbd>,</Kbd>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={onOpenShortcuts}>
                        <Keyboard />
                        <span className="flex-1">
                            {i18n("Keyboard shortcuts")}
                        </span>
                        <Kbd>?</Kbd>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openHelp()}>
                        <CircleHelp />
                        <span>{i18n("Help")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        disabled={isAutoSyncing}
                        onSelect={onSync}
                        title={lastSyncResult?.error}
                    >
                        {syncFailed ? (
                            <AlertCircle className="text-destructive" />
                        ) : (
                            <RefreshCw
                                className={isAutoSyncing ? "animate-spin" : ""}
                            />
                        )}
                        <span>
                            {isAutoSyncing
                                ? i18n("Syncing…")
                                : syncFailed
                                  ? i18n("Retry sync")
                                  : i18n("Sync device")}
                        </span>
                    </DropdownMenuItem>
                    {(lastSyncTime || nextSyncTime) && (
                        <div className="px-2 pb-1 text-xs text-muted-foreground">
                            {lastSyncTime && (
                                <p>
                                    {locale === "cs-CZ"
                                        ? "Naposledy synchronizováno"
                                        : "Last synced"}{" "}
                                    {lastSyncTime.toLocaleString(locale)}
                                </p>
                            )}
                            {nextSyncTime && (
                                <p>
                                    {locale === "cs-CZ"
                                        ? "Další synchronizace"
                                        : "Next sync"}{" "}
                                    {nextSyncTime.toLocaleString(locale)}
                                </p>
                            )}
                        </div>
                    )}
                    {isAdmin && (
                        <DropdownMenuItem onSelect={() => push("/admin")}>
                            <Shield />
                            <span className="flex-1">
                                {i18n("Admin dashboard")}
                            </span>
                        </DropdownMenuItem>
                    )}
                </div>

                <div className="border-t px-3 py-2">
                    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                        {i18n("Theme")}
                    </div>
                    <div
                        role="radiogroup"
                        aria-label={i18n("Theme")}
                        className="grid grid-cols-3 gap-1 rounded-md border bg-muted/40 p-0.5"
                    >
                        {themeOptions.map((opt) => {
                            const isActive = theme === opt.value;
                            return (
                                // biome-ignore lint/a11y/useSemanticElements: segmented control
                                <button
                                    key={opt.value}
                                    type="button"
                                    role="radio"
                                    aria-checked={isActive}
                                    onClick={() => setTheme(opt.value)}
                                    className={cn(
                                        "inline-flex items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-medium transition-colors",
                                        isActive
                                            ? "bg-background text-foreground shadow-sm"
                                            : "text-muted-foreground hover:text-foreground",
                                    )}
                                >
                                    <opt.icon
                                        className="size-3.5"
                                        aria-hidden="true"
                                    />
                                    {opt.label}
                                </button>
                            );
                        })}
                    </div>
                </div>

                <DropdownMenuSeparator className="my-0" />

                {/* Sign out */}
                <div className="p-1">
                    <DropdownMenuItem
                        variant="destructive"
                        onSelect={async () => {
                            if (posthog.__loaded) {
                                posthog.capture("user_signed_out");
                                posthog.reset();
                            }
                            await signOut();
                            push("/");
                            refresh();
                        }}
                    >
                        <LogOut /> {i18n("Log out")}
                    </DropdownMenuItem>
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
