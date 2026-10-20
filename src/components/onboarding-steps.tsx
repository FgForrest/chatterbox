"use client";

import {
    Bot,
    CalendarDays,
    Check,
    CircleCheck,
    Clipboard,
    Mail,
    Mic,
    Minus,
    Plug,
    Sparkles,
    Video,
} from "lucide-react";
import { useExtracted } from "next-intl";
import { useCallback, useState } from "react";
import { ConnectedLine } from "@/components/connected-line";
import { MeetingRecorderSetup } from "@/components/meeting-recorder-setup";
import { PlaudConnectTabs } from "@/components/plaud-connect-tabs";
import { useProductName } from "@/components/product-name-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type {
    OnboardingCapabilities,
    OnboardingReadiness,
    OnboardingStatus,
    ProviderReadiness,
} from "@/lib/onboarding/capabilities";

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

/** Welcome step for the setup wizard. */
export function OnboardingStepWelcome({
    audience = "single-user",
}: {
    audience?: OnboardingCapabilities["audience"];
}) {
    const i18n = useExtracted();
    const name = useProductName();
    return (
        <StepHeading
            icon={Sparkles}
            title={i18n("Set up {name}", { name })}
            description={
                audience === "organization-member"
                    ? i18n(
                          "Your Organization has set up shared services. Connect the personal sources you use. You can skip any integration and add it later.",
                      )
                    : audience === "organization-account"
                      ? i18n(
                            "Review the Organization's AI providers, defaults, and processing profiles. Members connect their personal sources from their own accounts.",
                        )
                      : i18n(
                            "Connect the services you use for recordings, transcription, and follow-up. You can skip any integration and add it later.",
                        )
            }
        />
    );
}

/** Plaud connection step for the setup wizard. */
export function OnboardingStepPlaud({
    hasPlaudConnection,
    employee = false,
    needsReconnect = false,
    status,
    onReconnect,
    onConnected,
}: {
    hasPlaudConnection: boolean;
    employee?: boolean;
    needsReconnect?: boolean;
    status?: OnboardingStatus;
    onReconnect: () => void;
    onConnected: () => void;
}) {
    const i18n = useExtracted();
    const name = useProductName();
    return (
        <div className="space-y-4">
            <StepHeading
                icon={Mic}
                title={
                    employee
                        ? i18n("Connect your own Plaud account")
                        : i18n("Connect your Plaud account")
                }
                description={
                    employee
                        ? i18n(
                              "Recordings shared with your Organization are already available without connecting Plaud. Connect only if you use your own recorder.",
                          )
                        : i18n(
                              "Bring recordings from your voice recorder into {name} automatically.",
                              { name },
                          )
                }
            />
            {(status === "checking" || status === "error") && (
                <p className="text-center text-sm">
                    {status === "checking"
                        ? i18n("Checking…")
                        : i18n("Could not check")}
                </p>
            )}
            {needsReconnect && (
                <p className="text-center text-sm">
                    {i18n("Plaud needs reconnecting")}
                </p>
            )}
            {employee && (
                <p className="text-sm text-muted-foreground">
                    {i18n(
                        "Using the Plaud Connector on this site? Add this site in the Connector's popup, then reload this page.",
                    )}
                </p>
            )}
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
    ai,
    audience,
    checking = false,
    onGoToSettings,
    profiles,
    onOpenProfiles,
}: {
    ai: OnboardingReadiness["ai"] | null;
    audience: OnboardingCapabilities["audience"];
    checking?: boolean;
    onGoToSettings: () => void;
    profiles?: OnboardingReadiness["profiles"];
    onOpenProfiles: () => void;
}) {
    const i18n = useExtracted();
    const transcriptionMissing = ai?.transcription.status === "not-connected";
    const summaryMissing = ai?.summary.status === "not-connected";
    return (
        <div className="space-y-4 text-center">
            <StepHeading
                icon={Bot}
                title={
                    audience === "organization-account"
                        ? i18n("Organization AI providers and defaults")
                        : i18n("Set up an AI provider")
                }
                description={
                    audience === "organization-account"
                        ? i18n(
                              "Review shared transcription, summaries, and default processing profiles for members.",
                          )
                        : ai?.transcription.source === "managed" &&
                            ai.transcription.status === "ready"
                          ? i18n(
                                "Mynah transcription is included with your plan. Add your own provider only if you want another transcription or summary service.",
                            )
                          : i18n(
                                "Review what can transcribe and summarize recordings. You can add a personal provider in Settings → Providers.",
                            )
                }
            />
            {checking ? (
                <p>{i18n("Checking…")}</p>
            ) : (
                <>
                    <p>
                        {i18n("Transcription")}:{" "}
                        <ProviderReadinessText provider={ai?.transcription} />
                    </p>
                    <p>
                        {i18n("Summaries")}:{" "}
                        <ProviderReadinessText provider={ai?.summary} />
                    </p>
                    {ai?.mailSummary && (
                        <p>
                            {i18n("Mail summaries")}:{" "}
                            <ProviderReadinessText provider={ai.mailSummary} />
                        </p>
                    )}
                    {ai?.mailSummary &&
                        ai.mailSummary.status === "not-connected" && (
                            <p>{i18n("Still needed: mail summaries.")}</p>
                        )}
                    {(transcriptionMissing || summaryMissing) && (
                        <p>
                            {transcriptionMissing && summaryMissing
                                ? i18n(
                                      "Still needed: transcription and summaries.",
                                  )
                                : transcriptionMissing
                                  ? i18n("Still needed: transcription.")
                                  : i18n("Still needed: summaries.")}
                        </p>
                    )}
                </>
            )}
            {ai?.transcription.source === "managed" &&
                ai.transcription.status === "ready" && (
                    <ConnectedLine>{i18n("Mynah is ready")}</ConnectedLine>
                )}
            <Button variant="outline" onClick={onGoToSettings}>
                {ai?.transcription.source === "managed" &&
                ai.transcription.status === "ready"
                    ? i18n("Add your own provider")
                    : i18n("Open provider settings")}
            </Button>
            {audience === "organization-account" && (
                <div className="space-y-2">
                    <p>
                        {i18n("Audio profile")}:{" "}
                        {profiles?.audio.name ??
                            (checking
                                ? i18n("Checking…")
                                : !ai || profiles?.audio.status === "error"
                                  ? i18n("Could not check")
                                  : i18n("No default profile"))}
                    </p>
                    <p>
                        {i18n("Mail profile")}:{" "}
                        {profiles?.mail?.name ??
                            (checking
                                ? i18n("Checking…")
                                : !ai || profiles?.mail?.status === "error"
                                  ? i18n("Could not check")
                                  : i18n("No default profile"))}
                    </p>
                    <Button variant="outline" onClick={onOpenProfiles}>
                        {i18n("Open profile settings")}
                    </Button>
                </div>
            )}
        </div>
    );
}

/** Present sanitized effective provider coverage. */
export function ProviderReadinessText({
    provider,
}: {
    provider: ProviderReadiness | undefined;
}) {
    const i18n = useExtracted();
    if (!provider || provider.status === "error")
        return i18n("Could not check");
    if (provider.status !== "ready") return i18n("Not ready");
    const name = provider.name ?? "";
    return provider.source === "organization"
        ? i18n("provided by your Organization ({name})", { name })
        : i18n("Ready ({name})", { name });
}

/** Google Calendar and Meet step for the setup wizard. */
export function OnboardingStepGoogle({ status }: { status: OnboardingStatus }) {
    const i18n = useExtracted();
    const connected = status === "connected";
    const calendarGranted = connected || status === "calendar-only";
    const meetGranted = connected;

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
            {(status === "checking" || status === "error") && (
                <p>
                    {status === "checking"
                        ? i18n("Checking…")
                        : i18n("Could not check")}
                </p>
            )}
            {status === "needs-reconnect" && (
                <p>{i18n("Google needs reconnecting")}</p>
            )}
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
    const name = useProductName();
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

/** Inbound mail introduction for the setup wizard. */
export function OnboardingStepMail({
    onOpenSettings,
    mail,
}: {
    onOpenSettings: () => void;
    mail: OnboardingReadiness["mail"];
}) {
    const i18n = useExtracted();
    const name = useProductName();
    const [copied, setCopied] = useState(false);
    const copyAddress = async () => {
        if (!mail.address) return;
        await navigator.clipboard.writeText(mail.address);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
    };
    return (
        <div className="space-y-4 text-center">
            <StepHeading
                icon={Mail}
                title={i18n("Send email to {name}", { name })}
                description={i18n(
                    "Your address needs no setup. Send or forward from your company email address. For automatic forwarding from other senders, use a secret address in Settings → Mail.",
                )}
            />
            <p>
                {mail.status === "ready"
                    ? i18n("Your address is ready")
                    : mail.status === "paused"
                      ? i18n(
                            "Mail receiving is paused. Sign in with your company account again.",
                        )
                      : mail.status === "ineligible"
                        ? i18n(
                              "Mail is available only to eligible company accounts signed in with single sign-on.",
                          )
                        : mail.status === "checking"
                          ? i18n("Checking…")
                          : i18n("Could not check")}
            </p>
            {mail.address && (
                <div className="mx-auto flex max-w-md items-center gap-2 rounded-lg border p-2">
                    <code className="min-w-0 flex-1 break-all text-sm">
                        {mail.address}
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
            )}
            <p className="text-sm text-muted-foreground">
                {i18n(
                    "Folder addresses are generated for each custom folder. Change them in the folder header. Mail sent To or Cc an Organization folder waits for you to share it with the Organization.",
                )}
            </p>
            <Button variant="outline" onClick={onOpenSettings}>
                {i18n("Open mail settings")}
            </Button>
        </div>
    );
}

/** Claude connector step for the setup wizard. */
export function OnboardingStepClaude({
    connectorUrl,
    confirmed,
    onConfirm,
}: {
    connectorUrl: string;
    confirmed: boolean;
    onConfirm: () => void;
}) {
    const i18n = useExtracted();
    const name = useProductName();
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
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                <li>
                    {i18n(
                        "Open Claude on claude.ai or in the desktop app, then Customize → Connectors.",
                    )}
                </li>
                <li>
                    {i18n(
                        "Find {name}, marked Custom, and click Connect. Sign in with your company account.",
                        { name },
                    )}
                </li>
                <li>
                    {i18n(
                        "In a conversation, click + in the message box, choose Connectors, and turn {name} on.",
                        { name },
                    )}
                </li>
            </ol>
            <Button variant="outline" onClick={onConfirm}>
                {confirmed
                    ? i18n("Set up (you confirmed)")
                    : i18n("Already set up")}
            </Button>
            <details className="rounded-lg border px-3 py-2 text-sm">
                <summary className="cursor-pointer font-medium">
                    {i18n("Not in your list?")}
                </summary>
                <p className="mt-2">
                    {i18n(
                        "On Claude Team or Enterprise, ask your administrator to add the connector. On a personal plan, open Customize → Connectors → Add custom connector.",
                    )}
                </p>
                <p>
                    {i18n(
                        "Name it {name} and paste the connector address. Under Advanced settings, enter the client ID and secret from your administrator. If given a key, add it under Request headers as x-api-key. Click Add, then Connect, and sign in.",
                        { name },
                    )}
                </p>
                <div className="my-2 flex items-center gap-2 rounded-lg border p-2">
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
                <details>
                    <summary>{i18n("Claude Code")}</summary>
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
                    <p>
                        {i18n(
                            "Then type /mcp in Claude Code, choose {connector}, and sign in in the browser window.",
                            { connector: "chatterbox" },
                        )}
                    </p>
                </details>
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
    status: OnboardingStatus;
    detail?: string;
    location: string;
}

/** Completion step for the setup wizard. */
export function OnboardingStepComplete({
    items,
}: {
    items: OnboardingSummaryItem[];
}) {
    const i18n = useExtracted();
    const statusText = (status: OnboardingStatus) => {
        switch (status) {
            case "checking":
                return i18n("Checking…");
            case "error":
                return i18n("Could not check");
            case "connected":
                return i18n("Connected");
            case "calendar-only":
                return i18n("Calendar only");
            case "needs-reconnect":
                return i18n("Reconnect needed");
            case "not-connected":
                return i18n("Not set up");
            case "ready":
                return i18n("Ready");
            case "paused":
                return i18n("Paused");
            case "ineligible":
                return i18n("Not eligible");
            case "available":
                return i18n("Available");
            case "confirmed":
                return i18n("Set up (you confirmed)");
            case "skipped":
                return i18n("Skipped");
        }
    };
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
                {items.map((item) => {
                    const ready = [
                        "connected",
                        "calendar-only",
                        "ready",
                        "confirmed",
                    ].includes(item.status);
                    return (
                        <li
                            key={item.id}
                            className={
                                ready
                                    ? "led-active flex items-center gap-2"
                                    : "flex items-center gap-2 text-muted-foreground"
                            }
                        >
                            {ready ? (
                                <CircleCheck className="size-4 shrink-0" />
                            ) : (
                                <Minus className="size-4 shrink-0" />
                            )}
                            <span>
                                {item.label}:{" "}
                                {item.detail ?? statusText(item.status)}
                                {![
                                    "connected",
                                    "calendar-only",
                                    "ready",
                                    "confirmed",
                                ].includes(item.status) &&
                                    ` · ${item.location}`}
                            </span>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
