"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/onboarding-dialog-base";
import {
    type OnboardingGoogleState,
    OnboardingStepAiProvider,
    OnboardingStepClaude,
    OnboardingStepComplete,
    OnboardingStepGoogle,
    OnboardingStepMail,
    OnboardingStepPlaud,
    OnboardingStepRecorder,
    OnboardingStepWelcome,
    type OnboardingSummaryItem,
} from "@/components/onboarding-steps";
import { useProductName } from "@/components/product-name-provider";
import { Button } from "@/components/ui/button";
import type { OnboardingCapabilities } from "@/lib/onboarding/capabilities";

/** Identifies a step that can be selected when opening onboarding. */
export type OnboardingStepId =
    | "welcome"
    | "plaud"
    | "ai-provider"
    | "google"
    | "recorder"
    | "mail"
    | "claude"
    | "complete";

interface StepContext {
    capabilities: OnboardingCapabilities;
    hasPlaudConnection: boolean;
    setHasPlaudConnection: (connected: boolean) => void;
    hasOwnProvider: boolean;
    hasIncludedProvider: boolean;
    googleConnection: OnboardingGoogleState;
    setGoogleConnection: (state: OnboardingGoogleState) => void;
    recorderConnected: boolean;
    setRecorderConnected: (connected: boolean) => void;
    mailReady: boolean;
    setMailReady: (ready: boolean) => void;
    summaryItems: OnboardingSummaryItem[];
    openSettings: (section: string) => void;
}

interface StepDefinition {
    id: OnboardingStepId;
    visible: (capabilities: OnboardingCapabilities) => boolean;
    skippable: boolean;
    content: (context: StepContext) => ReactNode;
}

function alwaysVisible() {
    return true;
}

function renderWelcome() {
    return <OnboardingStepWelcome />;
}

function renderPlaud(context: StepContext) {
    return (
        <OnboardingStepPlaud
            hasPlaudConnection={context.hasPlaudConnection}
            onReconnect={() => context.setHasPlaudConnection(false)}
            onConnected={() => context.setHasPlaudConnection(true)}
        />
    );
}

function renderAiProvider(context: StepContext) {
    return (
        <OnboardingStepAiProvider
            hasOwnProvider={context.hasOwnProvider}
            hasIncludedProvider={context.hasIncludedProvider}
            onGoToSettings={() => context.openSettings("providers")}
        />
    );
}

function renderGoogle(context: StepContext) {
    return (
        <OnboardingStepGoogle
            onConnectionChange={context.setGoogleConnection}
        />
    );
}

function renderRecorder(context: StepContext) {
    return (
        <OnboardingStepRecorder
            storeUrl={context.capabilities.recorderStoreUrl}
            onConnected={() => context.setRecorderConnected(true)}
        />
    );
}

function renderMail(context: StepContext) {
    return (
        <OnboardingStepMail
            onOpenSettings={() => context.openSettings("mail")}
            onReady={context.setMailReady}
        />
    );
}

function renderClaude(context: StepContext) {
    const connectorUrl = context.capabilities.mcpConnectorUrl;
    return connectorUrl ? (
        <OnboardingStepClaude connectorUrl={connectorUrl} />
    ) : null;
}

function renderComplete(context: StepContext) {
    return <OnboardingStepComplete items={context.summaryItems} />;
}

const STEPS: StepDefinition[] = [
    {
        id: "welcome",
        visible: alwaysVisible,
        skippable: false,
        content: renderWelcome,
    },
    {
        id: "plaud",
        visible: alwaysVisible,
        skippable: true,
        content: renderPlaud,
    },
    {
        id: "ai-provider",
        visible: alwaysVisible,
        skippable: true,
        content: renderAiProvider,
    },
    {
        id: "google",
        visible: (capabilities) => capabilities.googleConfigured,
        skippable: true,
        content: renderGoogle,
    },
    {
        id: "recorder",
        visible: alwaysVisible,
        skippable: true,
        content: renderRecorder,
    },
    {
        id: "mail",
        visible: (capabilities) => capabilities.mailAvailable,
        skippable: true,
        content: renderMail,
    },
    {
        id: "claude",
        visible: (capabilities) => capabilities.mcpConnectorUrl !== null,
        skippable: true,
        content: renderClaude,
    },
    {
        id: "complete",
        visible: alwaysVisible,
        skippable: false,
        content: renderComplete,
    },
];

interface OnboardingDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onComplete: () => void;
    capabilities: OnboardingCapabilities;
    mandatory?: boolean;
    initialStep?: OnboardingStepId;
}

/** First-run and voluntary setup wizard. */
export function OnboardingDialog({
    open,
    onOpenChange,
    onComplete,
    capabilities,
    mandatory = false,
    initialStep = "welcome",
}: OnboardingDialogProps) {
    const i18n = useExtracted();
    const name = useProductName();
    const { refresh } = useRouter();
    const visibleSteps = useMemo(
        () => STEPS.filter((definition) => definition.visible(capabilities)),
        [capabilities],
    );
    const [step, setStep] = useState<OnboardingStepId>(initialStep);
    const [hasPlaudConnection, setHasPlaudConnection] = useState(false);
    const [hasOwnProvider, setHasOwnProvider] = useState(false);
    const [hasIncludedProvider, setHasIncludedProvider] = useState(false);
    const [googleConnection, setGoogleConnection] =
        useState<OnboardingGoogleState>("not-connected");
    const [recorderConnected, setRecorderConnected] = useState(false);
    const [mailReady, setMailReady] = useState(false);

    useEffect(() => {
        if (!open) return;
        const requested = visibleSteps.find(
            (definition) => definition.id === initialStep,
        );
        setStep(requested?.id ?? "welcome");
    }, [initialStep, open, visibleSteps]);

    useEffect(() => {
        if (!open || step !== "plaud") return;
        fetch("/api/plaud/connection")
            .then((response) => response.json())
            .then((data: { connected?: boolean }) => {
                setHasPlaudConnection(data.connected === true);
            })
            .catch(() => undefined);
    }, [open, step]);

    useEffect(() => {
        if (!open || step !== "ai-provider") return;
        fetch("/api/settings/ai/providers")
            .then((response) => response.json())
            .then((data: { providers?: Array<{ managed?: boolean }> }) => {
                const providers = data.providers ?? [];
                setHasOwnProvider(
                    providers.some((provider) => !provider.managed),
                );
                setHasIncludedProvider(
                    providers.some((provider) => provider.managed),
                );
            })
            .catch(() => undefined);
    }, [open, step]);

    useEffect(() => {
        if (open) return;
        setStep("welcome");
        setHasPlaudConnection(false);
        setHasOwnProvider(false);
        setHasIncludedProvider(false);
        setGoogleConnection("not-connected");
        setRecorderConnected(false);
        setMailReady(false);
    }, [open]);

    const stepIndex = Math.max(
        0,
        visibleSteps.findIndex((definition) => definition.id === step),
    );
    const definition = visibleSteps[stepIndex] ?? visibleSteps[0];
    const previous = stepIndex > 0 ? visibleSteps[stepIndex - 1] : undefined;
    const next = visibleSteps[stepIndex + 1];

    const openSettings = (section: string) => {
        onOpenChange(false);
        window.location.href = `/dashboard?settings=${encodeURIComponent(section)}`;
    };

    const handleComplete = async () => {
        try {
            const response = await fetch("/api/settings/user", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ onboardingCompleted: true }),
            });
            if (!response.ok) throw new Error("onboarding completion failed");
            onComplete();
            onOpenChange(false);
            refresh();
        } catch {
            toast.error(i18n("Failed to complete onboarding"));
        }
    };

    const summaryItems: OnboardingSummaryItem[] = [
        {
            id: "plaud",
            label: i18n("Plaud"),
            status: hasPlaudConnection ? "connected" : "skipped",
            location: i18n("Settings → Plaud Account"),
        },
        {
            id: "ai-provider",
            label: i18n("AI provider"),
            status:
                hasOwnProvider || hasIncludedProvider ? "connected" : "skipped",
            location: i18n("Settings → Providers"),
        },
    ];
    if (capabilities.googleConfigured) {
        let googleStatus: OnboardingSummaryItem["status"] = "skipped";
        if (googleConnection === "calendar-meet") {
            googleStatus = "connected";
        }
        if (googleConnection === "calendar-only") {
            googleStatus = "calendar-only";
        }
        summaryItems.push({
            id: "google",
            label: i18n("Google"),
            status: googleStatus,
            location: i18n("Settings → Google Account"),
        });
    }
    summaryItems.push({
        id: "recorder",
        label: i18n("Recorder"),
        status: recorderConnected ? "connected" : "skipped",
        location: i18n("Settings → Meeting Recorder"),
    });
    if (capabilities.mailAvailable) {
        summaryItems.push({
            id: "mail",
            label: i18n("Mail"),
            status: mailReady ? "connected" : "skipped",
            location: i18n("Settings → Mail"),
        });
    }
    if (capabilities.mcpConnectorUrl) {
        summaryItems.push({
            id: "claude",
            label: i18n("Claude"),
            status: "skipped",
            location: i18n("Menu → Run setup again"),
        });
    }

    const context: StepContext = {
        capabilities,
        hasPlaudConnection,
        setHasPlaudConnection,
        hasOwnProvider,
        hasIncludedProvider,
        googleConnection,
        setGoogleConnection,
        recorderConnected,
        setRecorderConnected,
        mailReady,
        setMailReady,
        summaryItems,
        openSettings,
    };
    const progress = ((stepIndex + 1) / visibleSteps.length) * 100;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                aria-describedby={undefined}
                className="max-h-[90vh] max-w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-[600px]"
                hideCloseButton={mandatory}
                onEscapeKeyDown={(event) => {
                    if (mandatory) event.preventDefault();
                }}
                onPointerDownOutside={(event) => {
                    if (mandatory) event.preventDefault();
                }}
                onInteractOutside={(event) => {
                    if (mandatory) event.preventDefault();
                }}
            >
                <DialogHeader>
                    <DialogTitle className="sr-only">
                        {i18n("Set up {name}", { name })}
                    </DialogTitle>
                </DialogHeader>

                <div className="space-y-5">
                    <div className="space-y-2">
                        <p className="text-center text-xs text-muted-foreground">
                            {i18n("Step {current} of {total}", {
                                current: String(stepIndex + 1),
                                total: String(visibleSteps.length),
                            })}
                        </p>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                                aria-label={i18n("Setup progress")}
                                aria-valuemax={100}
                                aria-valuemin={0}
                                aria-valuenow={Math.round(progress)}
                                className="h-full rounded-full bg-primary transition-[width]"
                                role="progressbar"
                                style={{ width: `${progress}%` }}
                            />
                        </div>
                    </div>

                    {definition?.content(context)}

                    <DialogFooter className="flex-row items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                            {previous && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setStep(previous.id)}
                                >
                                    <ArrowLeft className="size-4" />
                                    <span className="hidden min-[390px]:inline">
                                        {i18n("Previous")}
                                    </span>
                                </Button>
                            )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                            {definition?.skippable && next && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setStep(next.id)}
                                >
                                    {i18n("Skip")}
                                </Button>
                            )}
                            {definition?.id === "complete" ? (
                                <Button size="sm" onClick={handleComplete}>
                                    {i18n("Get started")}
                                    <ArrowRight className="size-4" />
                                </Button>
                            ) : (
                                next && (
                                    <Button
                                        size="sm"
                                        onClick={() => setStep(next.id)}
                                    >
                                        {i18n("Next")}
                                        <ArrowRight className="size-4" />
                                    </Button>
                                )
                            )}
                        </div>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}
