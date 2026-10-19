"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/onboarding-dialog-base";
import {
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
import type {
    OnboardingCapabilities,
    OnboardingReadiness,
    OnboardingStatus,
} from "@/lib/onboarding/capabilities";
import {
    browserRecorderExtensionClient,
    type RecorderExtensionState,
} from "@/lib/recorder-extension/client";
import { RECORDER_EXTENSION_ID } from "@/lib/recorder-extension/extension-id";
import type { SettingsSection } from "@/types/settings";

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

interface StepDefinition {
    id: OnboardingStepId;
    skippable: boolean;
}
const STEPS: StepDefinition[] = [
    { id: "welcome", skippable: false },
    { id: "plaud", skippable: true },
    { id: "ai-provider", skippable: true },
    { id: "google", skippable: true },
    { id: "recorder", skippable: true },
    { id: "mail", skippable: true },
    { id: "claude", skippable: true },
    { id: "complete", skippable: false },
];

interface OnboardingDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onComplete: () => void;
    capabilities: OnboardingCapabilities;
    initialReadiness?: OnboardingReadiness;
    mandatory?: boolean;
    initialStep?: OnboardingStepId;
    suspended?: boolean;
    onOpenSettings: (section: SettingsSection) => void;
}

/** First-run and voluntary setup wizard, preserving progress during Settings. */
export function OnboardingDialog({
    open,
    onOpenChange,
    onComplete,
    capabilities,
    initialReadiness,
    mandatory = false,
    initialStep = "welcome",
    suspended = false,
    onOpenSettings,
}: OnboardingDialogProps) {
    const i18n = useExtracted();
    const name = useProductName();
    const { refresh } = useRouter();
    const [step, setStep] = useState<OnboardingStepId>(initialStep);
    const [readiness, setReadiness] = useState(initialReadiness ?? null);
    const [failed, setFailed] = useState(false);
    const [skipped, setSkipped] = useState<Set<OnboardingStepId>>(new Set());
    const [plaudOverride, setPlaudOverride] = useState<OnboardingStatus | null>(
        null,
    );
    const [claudeConfirmed, setClaudeConfirmed] = useState(false);
    const [recorderStatus, setRecorderStatus] =
        useState<OnboardingStatus>("checking");
    const personal = capabilities.audience !== "organization-account";
    const requiredProviders = readiness
        ? [
              readiness.ai.transcription,
              readiness.ai.summary,
              ...(readiness.ai.mailSummary ? [readiness.ai.mailSummary] : []),
          ]
        : [];
    const organizationAi =
        requiredProviders.length > 0 &&
        requiredProviders.every(
            (provider) =>
                provider.status === "ready" &&
                provider.source === "organization",
        );
    const showAi = !(
        capabilities.audience === "organization-member" &&
        organizationAi &&
        !failed
    );
    const visible = (id: OnboardingStepId) => {
        if (id === "welcome" || id === "complete") return true;
        if (id === "ai-provider") return showAi;
        if (!personal) return false;
        if (id === "google") return capabilities.googleConfigured;
        if (id === "mail") return capabilities.mailAvailable;
        if (id === "claude") return capabilities.mcpConnectorUrl !== null;
        return true;
    };
    const visibleSteps = STEPS.filter((definition) => visible(definition.id));

    useEffect(() => {
        if (!open) return;
        setStep(initialStep);
        setSkipped(new Set());
        setClaudeConfirmed(false);
    }, [initialStep, open]);

    useEffect(() => {
        if (!open || suspended) return;
        const controller = new AbortController();
        const load = async () => {
            setPlaudOverride(null);
            try {
                const response = await fetch("/api/onboarding/readiness", {
                    signal: controller.signal,
                    cache: "no-store",
                });
                if (!response.ok) throw new Error("readiness check failed");
                const snapshot = (await response.json()) as OnboardingReadiness;
                if (controller.signal.aborted) return;
                setReadiness(snapshot);
                setFailed(false);
            } catch {
                if (!controller.signal.aborted) setFailed(true);
            }
        };
        void load();
        window.addEventListener("focus", load);
        return () => {
            controller.abort();
            window.removeEventListener("focus", load);
        };
    }, [open, suspended]);

    const handleRecorderState = useCallback((state: RecorderExtensionState) => {
        setRecorderStatus(
            state.kind === "reachable" && state.paired && state.pairedHere
                ? "ready"
                : "not-connected",
        );
    }, []);
    useEffect(() => {
        if (!open || !personal || suspended) return;
        let cancelled = false;
        const client = browserRecorderExtensionClient();
        const detect = async () => {
            try {
                const state = await client.detect(RECORDER_EXTENSION_ID);
                if (!cancelled) handleRecorderState(state);
            } catch {
                if (!cancelled) setRecorderStatus("error");
            }
        };
        void detect();
        const stop = client.onPresence(handleRecorderState);
        const interval = window.setInterval(detect, 2000);
        window.addEventListener("focus", detect);
        return () => {
            cancelled = true;
            stop();
            window.clearInterval(interval);
            window.removeEventListener("focus", detect);
        };
    }, [open, personal, suspended, handleRecorderState]);

    const handleRecorderConnected = useCallback(
        () => setRecorderStatus("ready"),
        [],
    );
    const status = (value: OnboardingStatus | undefined): OnboardingStatus =>
        failed ? "error" : (value ?? "checking");
    const plaudStatus = plaudOverride ?? status(readiness?.plaud);
    const googleStatus = status(readiness?.google);
    const stepIndex = Math.max(
        0,
        visibleSteps.findIndex((definition) => definition.id === step),
    );
    const effectiveIndex =
        step === "ai-provider" && !showAi
            ? visibleSteps.findIndex(
                  (definition) =>
                      STEPS.findIndex((item) => item.id === definition.id) > 2,
              )
            : stepIndex;
    const definition = visibleSteps[effectiveIndex] ?? visibleSteps[0];
    const previous =
        effectiveIndex > 0 ? visibleSteps[effectiveIndex - 1] : undefined;
    const next = visibleSteps[effectiveIndex + 1];
    const progress = ((effectiveIndex + 1) / visibleSteps.length) * 100;

    const summaryItems: OnboardingSummaryItem[] = [];
    const add = (
        id: OnboardingStepId,
        label: string,
        result: OnboardingStatus,
        location: string,
        detail?: string,
    ) => {
        summaryItems.push({
            id,
            label,
            status: skipped.has(id) ? "skipped" : result,
            location,
            detail: skipped.has(id) ? undefined : detail,
        });
    };
    if (personal)
        add(
            "plaud",
            i18n("Plaud"),
            plaudStatus,
            i18n("Settings → Plaud Account"),
        );
    const aiReady =
        requiredProviders.length > 0 &&
        requiredProviders.every((provider) => provider.status === "ready");
    const aiError = requiredProviders.some(
        (provider) => provider.status === "error",
    );
    const aiStatus = status(
        !readiness
            ? undefined
            : aiError
              ? "error"
              : aiReady
                ? "ready"
                : "not-connected",
    );
    const providerNames = [
        ...new Set(
            requiredProviders.flatMap((provider) =>
                provider.name ? [provider.name] : [],
            ),
        ),
    ].join(", ");
    add(
        "ai-provider",
        i18n("AI"),
        aiStatus,
        i18n("Settings → Providers"),
        organizationAi && !failed
            ? i18n("provided by your Organization ({name})", {
                  name: providerNames,
              })
            : aiReady && !failed
              ? i18n("Ready ({name})", { name: providerNames })
              : undefined,
    );
    if (
        readiness &&
        !failed &&
        !organizationAi &&
        !skipped.has("ai-provider")
    ) {
        const coverage = [
            [
                "transcription",
                i18n("AI transcription"),
                readiness.ai.transcription,
            ],
            ["summary", i18n("AI summaries"), readiness.ai.summary],
            ...(readiness.ai.mailSummary
                ? [
                      [
                          "mail",
                          i18n("Mail summaries"),
                          readiness.ai.mailSummary,
                      ] as const,
                  ]
                : []),
        ] as const;
        for (const [role, label, provider] of coverage) {
            summaryItems.push({
                id: `ai-${role}`,
                label,
                status: provider.status,
                location: i18n("Settings → Providers"),
                detail:
                    provider.status === "ready"
                        ? provider.source === "organization"
                            ? i18n("provided by your Organization ({name})", {
                                  name: provider.name ?? "",
                              })
                            : i18n("Ready ({name})", {
                                  name: provider.name ?? "",
                              })
                        : undefined,
            });
        }
    }
    if (personal && capabilities.googleConfigured)
        add(
            "google",
            i18n("Google"),
            googleStatus,
            i18n("Settings → Google Account"),
        );
    if (personal)
        add(
            "recorder",
            i18n("Recorder"),
            recorderStatus,
            i18n("Settings → Meeting Recorder"),
            recorderStatus === "ready"
                ? i18n("Paired with this site")
                : undefined,
        );
    if (personal && capabilities.mailAvailable)
        add(
            "mail",
            i18n("Mail"),
            status(readiness?.mail.status),
            i18n("Settings → Mail"),
        );
    if (personal && capabilities.mcpConnectorUrl)
        add(
            "claude",
            i18n("Claude"),
            claudeConfirmed ? "confirmed" : "available",
            i18n("Menu → Re-run setup"),
        );
    if (!personal) {
        for (const [channel, profile] of Object.entries(
            readiness?.profiles ?? {
                audio: { status: "checking", name: null },
                mail: { status: "checking", name: null },
            },
        )) {
            if (profile)
                summaryItems.push({
                    id: `profile-${channel}`,
                    label:
                        channel === "audio"
                            ? i18n("Audio profile")
                            : i18n("Mail profile"),
                    status: status(profile.status),
                    detail: failed ? undefined : (profile.name ?? undefined),
                    location: i18n("Settings → Profiles"),
                });
        }
    }

    let content: ReactNode;
    switch (definition.id) {
        case "welcome":
            content = (
                <OnboardingStepWelcome audience={capabilities.audience} />
            );
            break;
        case "plaud":
            content = (
                <OnboardingStepPlaud
                    hasPlaudConnection={plaudStatus === "connected"}
                    status={plaudStatus}
                    needsReconnect={plaudStatus === "needs-reconnect"}
                    employee={capabilities.audience === "organization-member"}
                    onReconnect={() => setPlaudOverride("not-connected")}
                    onConnected={() => setPlaudOverride("connected")}
                />
            );
            break;
        case "ai-provider":
            content = (
                <OnboardingStepAiProvider
                    ai={failed ? null : (readiness?.ai ?? null)}
                    audience={capabilities.audience}
                    checking={!readiness && !failed}
                    profiles={failed ? undefined : readiness?.profiles}
                    onGoToSettings={() => onOpenSettings("providers")}
                    onOpenProfiles={() => onOpenSettings("profiles")}
                />
            );
            break;
        case "google":
            content = <OnboardingStepGoogle status={googleStatus} />;
            break;
        case "recorder":
            content = (
                <OnboardingStepRecorder
                    storeUrl={capabilities.recorderStoreUrl}
                    onConnected={handleRecorderConnected}
                />
            );
            break;
        case "mail":
            content = (
                <OnboardingStepMail
                    mail={
                        failed
                            ? { status: "error", address: null }
                            : (readiness?.mail ?? {
                                  status: "checking",
                                  address: null,
                              })
                    }
                    onOpenSettings={() => onOpenSettings("mail")}
                />
            );
            break;
        case "claude":
            content = (
                <OnboardingStepClaude
                    connectorUrl={capabilities.mcpConnectorUrl ?? ""}
                    confirmed={claudeConfirmed}
                    onConfirm={() => setClaudeConfirmed(true)}
                />
            );
            break;
        case "complete":
            content = <OnboardingStepComplete items={summaryItems} />;
            break;
    }

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
    return (
        <Dialog open={open && !suspended} onOpenChange={onOpenChange}>
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
                                current: String(effectiveIndex + 1),
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

                    {content}

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
                                    onClick={() => {
                                        setSkipped((current) =>
                                            new Set(current).add(definition.id),
                                        );
                                        setStep(next.id);
                                    }}
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
                                        onClick={() => {
                                            setSkipped((current) => {
                                                const updated = new Set(
                                                    current,
                                                );
                                                updated.delete(definition.id);
                                                return updated;
                                            });
                                            setStep(next.id);
                                        }}
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
