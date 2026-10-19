"use client";

import { usePathname, useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
} from "react";
import { toast } from "sonner";
import { AppUploadButton } from "@/components/app-upload-button";
import { CommandPalette } from "@/components/dashboard/command-palette";
import { ShortcutsDialog } from "@/components/dashboard/shortcuts-dialog";
import {
    OnboardingDialog,
    type OnboardingStepId,
} from "@/components/onboarding-dialog";
import { type Provider, SettingsDialog } from "@/components/settings-dialog";
import { Button } from "@/components/ui/button";
import { useAutoSync } from "@/hooks/use-auto-sync";
import { useGoogleConnectOutcome } from "@/hooks/use-google-connection";
import { useTheme } from "@/hooks/use-theme";
import {
    requestNotificationPermission,
    showNewRecordingNotification,
    showSyncCompleteNotification,
} from "@/lib/notifications/browser";
import {
    type OnboardingCapabilities,
    type OnboardingReadiness,
    shouldOpenOnboarding,
} from "@/lib/onboarding/capabilities";
import { pageSearchScope } from "@/lib/search/types";
import type { InitialSettings } from "@/lib/settings/initial-settings";
import { SYNC_CONFIG } from "@/lib/sync-config";

export interface AppChromeConfig {
    initialSettings: InitialSettings;
    isAdmin: boolean;
    isOrgAccount: boolean;
    userEmail: string | null;
    isHosted: boolean;
    mailEnabled: boolean;
    accessManagement: boolean;
    onboardingCapabilities: OnboardingCapabilities;
    onboardingReadiness?: OnboardingReadiness;
}

function useChromeState(config: AppChromeConfig) {
    const i18n = useExtracted();
    const { refresh } = useRouter();
    const pathname = usePathname();
    const demo = pathname.startsWith("/dev/demo-dashboard");
    const { initialSettings } = config;
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [onboardingSettings, setOnboardingSettings] = useState(false);
    const handleSettingsOpenChange = useCallback((open: boolean) => {
        setSettingsOpen(open);
        if (!open) setOnboardingSettings(false);
    }, []);
    const [onboardingOpen, setOnboardingOpen] = useState(
        () =>
            !demo && shouldOpenOnboarding(initialSettings.onboardingCompleted),
    );
    const [onboardingInitialStep, setOnboardingInitialStep] =
        useState<OnboardingStepId>("welcome");
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [providers, setProviders] = useState<Provider[]>([]);
    const uploadButtonRef = useRef<HTMLButtonElement>(null);
    const { theme, setTheme } = useTheme(initialSettings.theme);
    useGoogleConnectOutcome();
    const sync = useAutoSync({
        interval: initialSettings.syncInterval ?? SYNC_CONFIG.defaultInterval,
        minInterval: SYNC_CONFIG.minInterval,
        syncOnMount: initialSettings.syncOnMount,
        syncOnVisibilityChange: initialSettings.syncOnVisibilityChange,
        enabled: !demo && initialSettings.autoSyncEnabled,
        onSuccess: (newRecordings) => {
            if (initialSettings.syncNotifications !== false) {
                toast.success(
                    newRecordings > 0
                        ? i18n(
                              "Synced {count, plural, one {# new recording} other {# new recordings}}",
                              { count: newRecordings },
                          )
                        : i18n("Sync complete - no new recordings"),
                );
            }
            if (initialSettings.browserNotifications) {
                void requestNotificationPermission().then((granted) => {
                    if (!granted) return;
                    if (newRecordings > 0)
                        showNewRecordingNotification(newRecordings);
                    else showSyncCompleteNotification();
                });
            }
        },
        onError: (error) => toast.error(error),
    });
    const handleReconnected = useCallback(() => {
        refresh();
        void sync.manualSync();
    }, [refresh, sync.manualSync]);
    useEffect(() => {
        const url = new URL(window.location.href);
        if (url.searchParams.get("onboarding") !== "google") return;
        setOnboardingInitialStep("google");
        setOnboardingOpen(true);
        url.searchParams.delete("onboarding");
        window.history.replaceState(window.history.state, "", url);
    }, []);
    useEffect(() => {
        if (!settingsOpen) return;
        const controller = new AbortController();
        void fetch("/api/settings/ai/providers?includeDisabled=true", {
            signal: controller.signal,
        })
            .then((response) => (response.ok ? response.json() : null))
            .then((data: { providers?: Provider[] } | null) => {
                if (!controller.signal.aborted)
                    setProviders(data?.providers ?? []);
            })
            .catch(() => {
                if (!controller.signal.aborted) setProviders([]);
            });
        return () => controller.abort();
    }, [settingsOpen]);
    useEffect(() => {
        const handler = (event: KeyboardEvent) => {
            if (
                (event.metaKey || event.ctrlKey) &&
                event.key.toLowerCase() === "k"
            ) {
                event.preventDefault();
                if (!settingsOpen && !onboardingOpen && !shortcutsOpen)
                    setPaletteOpen((open) => !open);
                return;
            }
            if (settingsOpen || onboardingOpen || shortcutsOpen || paletteOpen)
                return;
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            const target = event.target;
            if (
                target instanceof HTMLElement &&
                (target.closest("input, textarea, select, [role=dialog]") ||
                    target.isContentEditable)
            )
                return;
            if (event.key === ",") {
                event.preventDefault();
                setSettingsOpen(true);
            }
            if (event.key === "?") {
                event.preventDefault();
                setShortcutsOpen(true);
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [settingsOpen, onboardingOpen, shortcutsOpen, paletteOpen]);
    return {
        ...config,
        isAdmin: !demo && config.isAdmin,
        ...sync,
        theme,
        setTheme,
        settingsOpen,
        setSettingsOpen: handleSettingsOpenChange,
        onboardingSettings,
        setOnboardingSettings,
        onboardingOpen,
        setOnboardingOpen,
        onboardingInitialStep,
        setOnboardingInitialStep,
        paletteOpen,
        setPaletteOpen,
        shortcutsOpen,
        setShortcutsOpen,
        providers,
        uploadButtonRef,
        handleReconnected,
    };
}

const AppChromeContext = createContext<ReturnType<
    typeof useChromeState
> | null>(null);

/** Owns the app's account dialogs, global shortcuts and synchronization. */
export function AppChromeProvider({
    children,
    ...config
}: AppChromeConfig & { children: ReactNode }) {
    const chrome = useChromeState(config);
    const i18n = useExtracted();
    const pathname = usePathname();
    const { refresh, push } = useRouter();
    const workstation =
        pathname.startsWith("/dashboard") ||
        pathname.startsWith("/dev/demo-dashboard");
    return (
        <AppChromeContext.Provider value={chrome}>
            {children}
            {!workstation && (
                <CommandPalette
                    key={pathname}
                    pageScope={pageSearchScope(pathname)}
                    open={chrome.paletteOpen}
                    onOpenChange={chrome.setPaletteOpen}
                    currentTheme={chrome.theme}
                    onSetTheme={chrome.setTheme}
                    dateTimeFormat={config.initialSettings.dateTimeFormat}
                    onSync={chrome.manualSync}
                    onUpload={() => chrome.uploadButtonRef.current?.click()}
                    onOpenSettings={() => chrome.setSettingsOpen(true)}
                    onOpenShortcuts={() => chrome.setShortcutsOpen(true)}
                />
            )}
            <ShortcutsDialog
                open={chrome.shortcutsOpen}
                onOpenChange={chrome.setShortcutsOpen}
            />
            <SettingsDialog
                open={chrome.settingsOpen}
                onOpenChange={(open) => {
                    chrome.setSettingsOpen(open);
                    if (
                        !open &&
                        !chrome.onboardingSettings &&
                        pathname === "/settings"
                    )
                        push("/dashboard");
                }}
                headerAction={
                    chrome.onboardingSettings ? (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => chrome.setSettingsOpen(false)}
                        >
                            {i18n("Return to setup")}
                        </Button>
                    ) : pathname === "/settings" ? (
                        <AppUploadButton />
                    ) : undefined
                }
                initialProviders={chrome.providers}
                isHosted={config.isHosted}
                isOrgAccount={config.isOrgAccount}
                mailEnabled={config.mailEnabled}
                accessManagement={config.accessManagement}
                onPlaudReconnected={chrome.handleReconnected}
            />
            <OnboardingDialog
                open={chrome.onboardingOpen}
                onOpenChange={chrome.setOnboardingOpen}
                onComplete={() => {
                    chrome.setOnboardingOpen(false);
                    refresh();
                }}
                mandatory={!config.initialSettings.onboardingCompleted}
                capabilities={config.onboardingCapabilities}
                initialReadiness={config.onboardingReadiness}
                suspended={chrome.onboardingSettings}
                onOpenSettings={(section) => {
                    window.location.hash = section;
                    window.dispatchEvent(new HashChangeEvent("hashchange"));
                    chrome.setOnboardingSettings(true);
                    chrome.setSettingsOpen(true);
                }}
                initialStep={chrome.onboardingInitialStep}
            />
        </AppChromeContext.Provider>
    );
}

/** Account actions and dialog state shared by every signed-in section. */
export function useAppChrome() {
    const chrome = useContext(AppChromeContext);
    if (!chrome) throw new Error("AppChromeProvider is required");
    return chrome;
}
