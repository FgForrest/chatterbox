"use client";

import {
    Bot,
    CalendarDays,
    Check,
    CircleCheck,
    Clipboard,
    LoaderCircle,
    Mail,
    Mic,
    Minus,
    Plug,
    Sparkles,
    Video,
} from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { MeetingRecorderSetup } from "@/components/meeting-recorder-setup";
import { PlaudConnectTabs } from "@/components/plaud-connect-tabs";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useGoogleConnection } from "@/hooks/use-google-connection";
import { productName } from "@/lib/brand";
import type { MailSettingsView } from "@/lib/mail/views";

function StepHeading({
    icon: Icon,
    title,
    description,
}: {
    icon: typeof Mic;
    title: string;
    description: string;
}) {
    return (
        <div className="space-y-2 text-center">
            <div className="mx-auto mb-3 flex size-14 items-center justify-center rounded-full bg-primary/10">
                <Icon className="size-7 text-primary" />
            </div>
            <h3 className="text-xl font-semibold">{title}</h3>
            <p className="text-muted-foreground">{description}</p>
        </div>
    );
}

function ConnectedLine({ children }: { children: React.ReactNode }) {
    return (
        <p className="led-active flex items-center justify-center gap-2 text-sm">
            <CircleCheck className="size-4" />
            {children}
        </p>
    );
}

/** Welcome step for the setup wizard. */
export function OnboardingStepWelcome() {
    const i18n = useExtracted();
    const name = productName(useLocale());
    return (
        <StepHeading
            icon={Sparkles}
            title={i18n("Set up {name}", { name })}
            description={i18n(
                "Connect the services you use for recordings, transcription, and follow-up. You can skip any integration and add it later.",
            )}
        />
    );
}

/** Plaud connection step for the setup wizard. */
export function OnboardingStepPlaud({
    hasPlaudConnection,
    onReconnect,
    onConnected,
}: {
    hasPlaudConnection: boolean;
    onReconnect: () => void;
    onConnected: () => void;
}) {
    const i18n = useExtracted();
    return (
        <div className="space-y-4">
            <StepHeading
                icon={Mic}
                title={i18n("Connect your Plaud account")}
                description={i18n(
                    "Bring recordings from your voice recorder into {name} automatically.",
                    { name: productName(useLocale()) },
                )}
            />
            {hasPlaudConnection ? (
                <div className="space-y-3 text-center">
                    <ConnectedLine>{i18n("Plaud is connected")}</ConnectedLine>
                    <Button variant="outline" size="sm" onClick={onReconnect}>
                        {i18n("Reconnect")}
                    </Button>
                </div>
            ) : (
                <Card>
                    <CardContent>
                        <PlaudConnectTabs onConnected={onConnected} />
                    </CardContent>
                </Card>
            )}
        </div>
    );
}

/** AI provider step for the setup wizard. */
export function OnboardingStepAiProvider({
    hasOwnProvider,
    hasIncludedProvider,
    onGoToSettings,
}: {
    hasOwnProvider: boolean;
    hasIncludedProvider: boolean;
    onGoToSettings: () => void;
}) {
    const i18n = useExtracted();
    let description = i18n(
        "Add the service that will transcribe and summarize your recordings.",
    );
    if (hasIncludedProvider) {
        description = i18n(
            "Mynah transcription is included with your plan. Add your own provider only if you want another transcription or summary service.",
        );
    }
    return (
        <div className="space-y-4 text-center">
            <StepHeading
                icon={Bot}
                title={i18n("Set up an AI provider")}
                description={description}
            />
            {hasOwnProvider && (
                <ConnectedLine>{i18n("AI provider connected")}</ConnectedLine>
            )}
            {!hasOwnProvider && hasIncludedProvider && (
                <ConnectedLine>{i18n("Mynah is ready")}</ConnectedLine>
            )}
            {!hasOwnProvider && (
                <Button variant="outline" onClick={onGoToSettings}>
                    {hasIncludedProvider
                        ? i18n("Add your own provider")
                        : i18n("Open provider settings")}
                </Button>
            )}
        </div>
    );
}

/** Google Calendar and Meet step for the setup wizard. */
export function OnboardingStepGoogle({
    onConnectionChange,
}: {
    onConnectionChange: (connected: boolean) => void;
}) {
    const i18n = useExtracted();
    const { state } = useGoogleConnection();
    const calendarGranted = state?.connection?.calendarGranted === true;
    const meetGranted = state?.connection?.meetGranted === true;
    const connected =
        state?.connection?.status === "active" &&
        calendarGranted &&
        meetGranted;

    useEffect(() => {
        onConnectionChange(
            state?.connection?.status === "active" && calendarGranted,
        );
    }, [calendarGranted, onConnectionChange, state?.connection?.status]);

    const connect = useCallback((purpose: "calendar" | "calendar-meet") => {
        const returnTo = "/dashboard?onboarding=google";
        window.location.assign(
            `/api/integrations/google/connect?purpose=${purpose}&returnTo=${encodeURIComponent(returnTo)}`,
        );
    }, []);

    return (
        <div className="space-y-4 text-center">
            <StepHeading
                icon={CalendarDays}
                title={i18n("Connect Google Calendar and Meet")}
                description={i18n(
                    "Learn can suggest speakers from the invited guests and Meet attendee list. Access is read-only and limited to event times, titles, and attendees, never mail or files.",
                )}
            />
            {connected && (
                <ConnectedLine>
                    {i18n("Calendar and Meet are connected")}
                </ConnectedLine>
            )}
            {!connected && (
                <div className="flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
                    <Button onClick={() => connect("calendar-meet")}>
                        {i18n("Connect Calendar and Meet")}
                    </Button>
                    {!calendarGranted && (
                        <Button
                            variant="outline"
                            onClick={() => connect("calendar")}
                        >
                            {i18n("Calendar only")}
                        </Button>
                    )}
                </div>
            )}
            {calendarGranted && !meetGranted && (
                <ConnectedLine>{i18n("Calendar is connected")}</ConnectedLine>
            )}
        </div>
    );
}

/** Meeting Recorder step for the setup wizard. */
export function OnboardingStepRecorder({
    storeUrl,
    onConnected,
}: {
    storeUrl: string;
    onConnected?: () => void;
}) {
    const i18n = useExtracted();
    const name = productName(useLocale());
    return (
        <div className="space-y-4">
            <StepHeading
                icon={Video}
                title={i18n("Connect Meeting Recorder")}
                description={i18n(
                    "Record meetings in your browser and send them straight to your {name} library.",
                    { name },
                )}
            />
            <MeetingRecorderSetup
                mode="onboarding"
                storeUrl={storeUrl}
                onConnected={onConnected}
            />
        </div>
    );
}

/** Inbound mail step for the setup wizard. */
export function OnboardingStepMail({
    onOpenSettings,
    onReady,
}: {
    onOpenSettings: () => void;
    onReady: (ready: boolean) => void;
}) {
    const i18n = useExtracted();
    const name = productName(useLocale());
    const [address, setAddress] = useState<string | null>(null);
    const [hasFolderAddresses, setHasFolderAddresses] = useState(false);
    const [loading, setLoading] = useState(true);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        fetch("/api/mail/addresses")
            .then(async (response) => {
                if (!response.ok) throw new Error("mail address load failed");
                return (await response.json()) as MailSettingsView;
            })
            .then((settings: MailSettingsView) => {
                if (cancelled) return;
                const mailbox =
                    settings.addresses.find((item) => item.kind === "mailbox")
                        ?.address ?? null;
                setAddress(mailbox);
                setHasFolderAddresses(
                    settings.addresses.some((item) => item.kind === "folder"),
                );
                onReady(mailbox !== null);
            })
            .catch(() => {
                if (!cancelled) onReady(false);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [onReady]);

    const copyAddress = async () => {
        if (!address) return;
        await navigator.clipboard.writeText(address);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
    };

    return (
        <div className="space-y-4 text-center">
            <StepHeading
                icon={Mail}
                title={i18n("Send email to {name}", { name })}
                description={i18n(
                    "Send or forward email to this address and it lands in your Chatter, ready to file like a recording.",
                )}
            />
            {loading && (
                <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                    <LoaderCircle className="size-4 animate-spin" />
                    {i18n("Loading your mail address…")}
                </p>
            )}
            {!loading && address && (
                <div className="space-y-3">
                    <ConnectedLine>
                        {i18n("Your address is ready")}
                    </ConnectedLine>
                    <div className="mx-auto flex max-w-md items-center gap-2 rounded-lg border p-2">
                        <code className="min-w-0 flex-1 break-all text-sm">
                            {address}
                        </code>
                        <Button
                            size="icon"
                            variant="outline"
                            aria-label={i18n("Copy email address")}
                            onClick={() => void copyAddress()}
                        >
                            {copied ? <Check /> : <Clipboard />}
                        </Button>
                    </div>
                    <p className="text-sm text-muted-foreground">
                        {hasFolderAddresses
                            ? i18n(
                                  "Folders can have their own addresses in Settings → Mail.",
                              )
                            : i18n(
                                  "Create folder addresses later in Settings → Mail.",
                              )}
                    </p>
                </div>
            )}
            {!loading && !address && (
                <Button variant="outline" onClick={onOpenSettings}>
                    {i18n("Open mail settings")}
                </Button>
            )}
        </div>
    );
}

/** Claude connector step for the setup wizard. */
export function OnboardingStepClaude({
    connectorUrl,
}: {
    connectorUrl: string;
}) {
    const i18n = useExtracted();
    const name = productName(useLocale());
    const [copied, setCopied] = useState<"url" | "command" | null>(null);
    const command = `claude mcp add --transport http --client-id claude-code chatterbox ${connectorUrl}`;
    const copy = async (kind: "url" | "command", value: string) => {
        await navigator.clipboard.writeText(value);
        setCopied(kind);
        window.setTimeout(() => setCopied(null), 1500);
    };
    return (
        <div className="space-y-4">
            <StepHeading
                icon={Plug}
                title={i18n("Connect Claude")}
                description={i18n(
                    "Ask Claude about your recordings, summaries, people, and tasks without leaving the conversation.",
                )}
            />
            <div className="flex items-center gap-2 rounded-lg border p-2">
                <code className="min-w-0 flex-1 break-all text-xs">
                    {connectorUrl}
                </code>
                <Button
                    size="icon"
                    variant="outline"
                    aria-label={i18n("Copy connector address")}
                    onClick={() => void copy("url", connectorUrl)}
                >
                    {copied === "url" ? <Check /> : <Clipboard />}
                </Button>
            </div>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                <li>
                    {i18n(
                        "Open Customize → Connectors → Add custom connector.",
                    )}
                </li>
                <li>
                    {i18n("Name it {name} and paste the connector address.", {
                        name,
                    })}
                </li>
                <li>{i18n("Add it, choose Connect, and sign in.")}</li>
            </ol>
            <details className="rounded-lg border px-3 py-2 text-sm">
                <summary className="cursor-pointer font-medium">
                    {i18n("Claude Code")}
                </summary>
                <div className="mt-2 flex items-start gap-2">
                    <code className="min-w-0 flex-1 break-all text-xs">
                        {command}
                    </code>
                    <Button
                        size="icon"
                        variant="outline"
                        aria-label={i18n("Copy Claude Code command")}
                        onClick={() => void copy("command", command)}
                    >
                        {copied === "command" ? <Check /> : <Clipboard />}
                    </Button>
                </div>
            </details>
            <a
                href="/docs/user-guide/claude"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline"
            >
                {i18n("Claude connector guide")}
            </a>
        </div>
    );
}

/** A setup-step result shown in the completion summary. */
export interface OnboardingSummaryItem {
    id: string;
    label: string;
    connected: boolean;
    location: string;
}

/** Completion step for the setup wizard. */
export function OnboardingStepComplete({
    items,
}: {
    items: OnboardingSummaryItem[];
}) {
    const i18n = useExtracted();
    return (
        <div className="space-y-4 text-center">
            <StepHeading
                icon={CircleCheck}
                title={i18n("Setup complete")}
                description={i18n(
                    "Here is what is ready and what you can finish later.",
                )}
            />
            <ul className="mx-auto w-fit space-y-2 text-left text-xs sm:text-sm">
                {items.map((item) => (
                    <li
                        key={item.id}
                        className={
                            item.connected
                                ? "led-active flex items-center gap-2"
                                : "flex items-center gap-2 text-muted-foreground"
                        }
                    >
                        {item.connected ? (
                            <CircleCheck className="size-4 shrink-0" />
                        ) : (
                            <Minus className="size-4 shrink-0" />
                        )}
                        <span>
                            {item.connected
                                ? i18n("{step}: Connected", {
                                      step: item.label,
                                  })
                                : i18n("{step}: Skipped · {location}", {
                                      step: item.label,
                                      location: item.location,
                                  })}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
