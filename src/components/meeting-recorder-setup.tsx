"use client";

import {
    Check,
    Copy,
    Download,
    ExternalLink,
    Plug,
    Trash2,
} from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import {
    type ReactNode,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";
import { toast } from "sonner";
import { useTimeZone } from "use-intl/react";
import { ConnectedLine } from "@/components/connected-line";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { useRecorderSetupMarker } from "@/hooks/use-recorder-setup-marker";
import { getApiErrorMessage } from "@/lib/api-errors";
import {
    browserRecorderExtensionClient,
    type RecorderExtensionState,
} from "@/lib/recorder-extension/client";
import { RECORDER_EXTENSION_ID } from "@/lib/recorder-extension/extension-id";
import { cn } from "@/lib/utils";

interface RecorderKey {
    id: string;
    name: string;
    key_prefix: string;
    created_at: string;
    last_used_at: string | null;
}

interface RecorderConfigResponse {
    extension_id: string;
    server_url: string | null;
    encrypted_recording_protocol: number;
    defaults: {
        auto_record_platforms: string[];
        auto_stop_quiet_seconds: number;
        notice_text: string;
        notice_text_is_default: boolean;
        lock_defaults: boolean;
    };
    platforms: { id: string; name: string }[];
}

interface RecorderStatus extends RecorderConfigResponse {
    keys: RecorderKey[];
    pending_captures: {
        client_recording_id: string;
        api_key_id: string;
        created_at: string;
        expires_at: string;
    }[];
}

interface PairResponse extends RecorderConfigResponse {
    key_id: string;
    api_key: string;
}

interface MeetingRecorderSetupProps {
    storeUrl: string;
    mode: "onboarding" | "settings";
    onConnected?: () => void;
}

function formatDate(
    value: string | null,
    locale: string,
    never: string,
    timeZone?: string,
) {
    return value ? new Date(value).toLocaleString(locale, { timeZone }) : never;
}

function hostOf(value: string | null): string {
    if (!value) return "";
    try {
        return new URL(value).host;
    } catch {
        return value;
    }
}

function StepMark({ children }: { children: ReactNode }) {
    return (
        <span
            className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs text-muted-foreground"
            aria-hidden="true"
        >
            {children}
        </span>
    );
}

/** Shared Meeting Recorder install, detection, pairing, and manual setup flow. */
export function MeetingRecorderSetup({
    storeUrl,
    mode,
    onConnected,
}: MeetingRecorderSetupProps) {
    const i18n = useExtracted();
    const locale = useLocale();
    const timeZone = useTimeZone();
    const [extension, setExtension] = useState<RecorderExtensionState | null>(
        null,
    );
    const [status, setStatus] = useState<RecorderStatus | null>(null);
    const [pageOrigin, setPageOrigin] = useState("");
    const [compatible, setCompatible] = useState<boolean | null>(null);
    const [busy, setBusy] = useState(false);
    const [pendingConfirmation, setPendingConfirmation] = useState(false);
    const [manualKey, setManualKey] = useState<string | null>(null);
    const [copied, setCopied] = useState<"key" | "url" | null>(null);
    const [rebindTargets, setRebindTargets] = useState<Record<string, string>>(
        {},
    );
    const [revokeCandidate, setRevokeCandidate] = useState<string | null>(null);
    const clientRef = useRef<ReturnType<
        typeof browserRecorderExtensionClient
    > | null>(null);
    const detectingRef = useRef(false);
    const connectingRef = useRef(false);
    const autoPairAttemptedRef = useRef(false);
    useRecorderSetupMarker(compatible !== false);

    const detect = useCallback(async () => {
        if (detectingRef.current) return null;
        detectingRef.current = true;
        try {
            if (!clientRef.current) {
                clientRef.current = browserRecorderExtensionClient();
            }
            const state = await clientRef.current.detect(RECORDER_EXTENSION_ID);
            setExtension(state);
            return state;
        } finally {
            detectingRef.current = false;
        }
    }, []);

    const loadStatus = useCallback(async () => {
        try {
            const response = await fetch("/api/settings/recorder/status");
            if (!response.ok) {
                throw new Error(
                    await getApiErrorMessage(
                        response,
                        i18n("Failed to load recorder status"),
                    ),
                );
            }
            setStatus((await response.json()) as RecorderStatus);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Failed to load recorder status"),
            );
        }
    }, [i18n]);

    useEffect(() => {
        setPageOrigin(window.location.origin);
        setCompatible(
            /\b(?:Chrome|Chromium|Edg|OPR)\//.test(navigator.userAgent) &&
                !/Android|Mobile|iPhone|iPad|iPod/.test(navigator.userAgent),
        );
        const client = browserRecorderExtensionClient();
        clientRef.current = client;
        void detect();
        void loadStatus();
        const check = () => void detect();
        const interval = window.setInterval(check, 2000);
        const stopPresence = client.onPresence((state) => setExtension(state));
        window.addEventListener("focus", check);
        return () => {
            window.clearInterval(interval);
            window.removeEventListener("focus", check);
            stopPresence();
        };
    }, [detect, loadStatus]);

    useEffect(() => {
        if (
            extension?.kind === "reachable" &&
            extension.paired &&
            extension.pairedHere
        ) {
            setPendingConfirmation(false);
            onConnected?.();
        }
    }, [extension, onConnected]);

    const mintKey = useCallback(async (): Promise<PairResponse> => {
        const installationId =
            extension?.kind === "reachable"
                ? extension.installationId
                : undefined;
        const response = await fetch("/api/settings/recorder/pair", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                label: navigator.platform || "browser",
                installationId,
            }),
        });
        if (!response.ok) {
            throw new Error(
                await getApiErrorMessage(
                    response,
                    i18n("Failed to create recorder key"),
                ),
            );
        }
        return (await response.json()) as PairResponse;
    }, [extension, i18n]);

    const connect = useCallback(async () => {
        if (
            !clientRef.current ||
            extension?.kind !== "reachable" ||
            connectingRef.current
        ) {
            return;
        }
        connectingRef.current = true;
        setBusy(true);
        try {
            const minted = await mintKey();
            const serverUrl = minted.server_url ?? pageOrigin;
            const result = await clientRef.current.pair(
                RECORDER_EXTENSION_ID,
                extension.channel,
                { serverUrl, apiKey: minted.api_key },
                extension.setupPending ? 15000 : 3000,
            );
            if (!result.ok) {
                throw new Error(
                    result.error ?? i18n("The extension refused pairing"),
                );
            }
            setPendingConfirmation(result.pending === true);
            toast.success(
                result.pending
                    ? i18n("Confirm this server in the extension")
                    : i18n("Recorder connected"),
            );
            await Promise.all([detect(), loadStatus()]);
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : i18n("Pairing failed"),
            );
        } finally {
            connectingRef.current = false;
            setBusy(false);
        }
    }, [detect, extension, i18n, loadStatus, mintKey, pageOrigin]);

    useEffect(() => {
        if (extension?.kind !== "reachable") return;
        if (!extension.setupPending) {
            autoPairAttemptedRef.current = false;
            return;
        }
        if (
            !pageOrigin ||
            busy ||
            (extension.paired && extension.pairedHere) ||
            autoPairAttemptedRef.current
        )
            return;
        autoPairAttemptedRef.current = true;
        void connect();
    }, [extension, pageOrigin, busy, connect]);

    const generateManual = useCallback(async () => {
        setBusy(true);
        try {
            const minted = await mintKey();
            setManualKey(minted.api_key);
            await loadStatus();
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Failed to create key"),
            );
        } finally {
            setBusy(false);
        }
    }, [i18n, loadStatus, mintKey]);

    const copy = useCallback(async (kind: "key" | "url", value: string) => {
        await navigator.clipboard.writeText(value);
        setCopied(kind);
        window.setTimeout(() => setCopied(null), 1500);
    }, []);

    const revoke = useCallback(
        async (id: string) => {
            try {
                const response = await fetch(`/api/settings/api-keys/${id}`, {
                    method: "DELETE",
                });
                if (!response.ok) {
                    throw new Error(
                        await getApiErrorMessage(
                            response,
                            i18n("Failed to revoke"),
                        ),
                    );
                }
                setRevokeCandidate(null);
                toast.success(i18n("Recorder key revoked"));
                await loadStatus();
            } catch (error) {
                toast.error(
                    error instanceof Error
                        ? error.message
                        : i18n("Failed to revoke"),
                );
            }
        },
        [i18n, loadStatus],
    );

    const rebind = useCallback(
        async (clientRecordingId: string) => {
            const apiKeyId = rebindTargets[clientRecordingId];
            if (!apiKeyId) return;
            const response = await fetch("/api/settings/recorder/rebind", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ clientRecordingId, apiKeyId }),
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not authorize capture recovery"),
                    ),
                );
                return;
            }
            toast.success(i18n("Recorder key updated"));
            await loadStatus();
        },
        [i18n, loadStatus, rebindTargets],
    );

    const manualServerUrl = status?.server_url ?? pageOrigin;
    const connectedHere =
        extension?.kind === "reachable" &&
        extension.paired &&
        extension.pairedHere;
    const connectedElsewhere =
        extension?.kind === "reachable" &&
        extension.paired &&
        !extension.pairedHere;
    const connectedHost = hostOf(
        connectedHere ? extension.pairedTo : manualServerUrl,
    );
    const extensionFound =
        extension !== null && extension.kind !== "not-installed";
    const unsupportedInOnboarding =
        mode === "onboarding" && compatible === false;
    const centered = mode === "onboarding";

    if (unsupportedInOnboarding) {
        return (
            <p className="text-sm text-muted-foreground">
                {i18n(
                    "Meeting Recorder works in desktop Chrome, Edge or Brave. Set it up from your computer with Re-run setup in the menu.",
                )}
            </p>
        );
    }

    const autoPlatformNames = status
        ? status.defaults.auto_record_platforms
              .map(
                  (id) =>
                      status.platforms.find((platform) => platform.id === id)
                          ?.name ?? id,
              )
              .join(", ")
        : "";

    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
                {i18n(
                    "Requires desktop Chrome, Edge, Brave, or another Chromium browser.",
                )}
            </p>
            <ol className="space-y-3 text-sm">
                <li className="flex items-start gap-3">
                    <StepMark>
                        {extensionFound ? <Check className="size-3.5" /> : "1"}
                    </StepMark>
                    <div className="space-y-2">
                        <p>{i18n("Install the extension")}</p>
                        {extensionFound && (
                            <p className="text-xs text-muted-foreground">
                                {i18n("Extension found")}
                            </p>
                        )}
                        {extension?.kind === "not-installed" &&
                            (mode === "settings" || compatible === true) && (
                                <Button asChild>
                                    <a
                                        href={storeUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        <ExternalLink
                                            className="size-4"
                                            aria-hidden="true"
                                        />
                                        {i18n("Install from Chrome Web Store")}
                                    </a>
                                </Button>
                            )}
                    </div>
                </li>
                <li className="flex items-start gap-3">
                    <StepMark>2</StepMark>
                    <div className="space-y-1">
                        <p>
                            {i18n(
                                "Click the extension icon in your browser toolbar and choose Connect to {host}.",
                                { host: hostOf(pageOrigin) },
                            )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {i18n(
                                "Can't see the icon? Open the puzzle piece (Extensions) in the toolbar.",
                            )}
                        </p>
                    </div>
                </li>
                <li className="flex items-start gap-3">
                    <StepMark>3</StepMark>
                    <p>
                        {i18n(
                            "Complete the three steps in the extension. This page will then connect automatically.",
                        )}
                    </p>
                </li>
            </ol>
            {extension?.kind === "reachable" &&
                extension.setupPending &&
                !connectedHere && (
                    <output className="block text-sm text-muted-foreground">
                        {busy
                            ? i18n("Sending the recorder key to the extension…")
                            : i18n(
                                  "Extension found. Complete setup in the extension; this page will connect automatically.",
                              )}
                    </output>
                )}
            {extension?.kind === "reachable" &&
                extension.micPermission &&
                extension.micPermission !== "granted" && (
                    <output className="block text-sm">
                        {i18n(
                            "Allow the microphone in the extension, or your voice will not be recorded",
                        )}
                    </output>
                )}
            {pendingConfirmation && (
                <output className="block text-sm">
                    {i18n("Confirm this server in the extension")}
                </output>
            )}
            {extension === null && (
                <p className="text-sm text-muted-foreground">
                    {i18n("Looking for the extension…")}
                </p>
            )}
            {compatible === false && (
                <p className="text-sm text-muted-foreground">
                    {i18n(
                        "Open this page in a supported desktop browser to connect.",
                    )}
                </p>
            )}
            {extension?.kind === "installed-unreachable" && (
                <p className="text-sm">
                    {i18n(
                        "Extension found. Open its toolbar icon and allow access to this site.",
                    )}
                </p>
            )}
            {extension?.kind === "reachable" && !extension.paired && (
                <div className={cn("space-y-2", centered && "text-center")}>
                    <Button onClick={() => void connect()} disabled={busy}>
                        <Plug className="size-4" />
                        {i18n("Connect")}
                    </Button>
                </div>
            )}
            {connectedHere && (
                <div
                    className={cn(
                        "flex flex-wrap items-center gap-2",
                        centered && "justify-center",
                    )}
                >
                    <ConnectedLine align={centered ? "center" : "start"}>
                        {i18n("Connected to {host}", { host: connectedHost })}
                    </ConnectedLine>
                    {mode === "settings" && (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void connect()}
                            disabled={busy}
                        >
                            {i18n("Rebind")}
                        </Button>
                    )}
                </div>
            )}
            {connectedElsewhere && (
                <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                        {i18n("Connected to {host}", {
                            host: hostOf(extension.pairedTo),
                        })}
                    </p>
                    <Button onClick={() => void connect()} disabled={busy}>
                        {i18n("Connect to this instance")}
                    </Button>
                </div>
            )}

            <details className="rounded-lg border px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium">
                    {i18n("Connect manually")}
                </summary>
                <div className="mt-3 space-y-3">
                    <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">
                            {i18n("Server URL")}
                        </p>
                        <div className="flex items-center gap-2">
                            <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 text-xs">
                                {manualServerUrl}
                            </code>
                            <Button
                                size="icon"
                                variant="outline"
                                aria-label={i18n("Copy server URL")}
                                onClick={() =>
                                    void copy("url", manualServerUrl)
                                }
                                disabled={!manualServerUrl}
                            >
                                {copied === "url" ? <Check /> : <Copy />}
                            </Button>
                        </div>
                    </div>
                    {manualKey ? (
                        <div className="space-y-2">
                            <code className="block break-all rounded bg-muted p-2 text-xs">
                                {manualKey}
                            </code>
                            <Button
                                variant="outline"
                                onClick={() => void copy("key", manualKey)}
                            >
                                {copied === "key" ? <Check /> : <Copy />}
                                {i18n("Copy key")}
                            </Button>
                            <p className="text-xs text-muted-foreground">
                                {i18n(
                                    "Shown once. Paste it into the extension settings.",
                                )}
                            </p>
                        </div>
                    ) : (
                        <Button
                            variant="outline"
                            onClick={() => void generateManual()}
                            disabled={busy}
                        >
                            <Download className="size-4" />
                            {i18n("Generate recorder key")}
                        </Button>
                    )}
                </div>
            </details>

            <a
                href="/docs/guides/meeting-recorder"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex text-sm text-primary hover:underline"
            >
                {i18n("Help with Meeting Recorder")}
            </a>

            {mode === "settings" && status && status.keys.length > 0 && (
                <details className="rounded-lg border px-3 py-2">
                    <summary className="cursor-pointer text-sm font-medium">
                        {i18n("Connected recorders")}
                    </summary>
                    <div className="mt-3 space-y-2">
                        <p className="text-xs text-muted-foreground">
                            {i18n(
                                "Each key can create recordings and look up folder names to file them, but cannot read recordings.",
                            )}
                        </p>
                        {status.keys.map((key) => (
                            <div
                                key={key.id}
                                className="space-y-2 rounded border p-2 text-sm"
                            >
                                <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="flex min-w-0 items-center gap-2">
                                            <span className="truncate font-medium">
                                                {key.name}
                                            </span>
                                            <span className="shrink-0 rounded border px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                                                {key.key_prefix}
                                            </span>
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {i18n("Last used {date}", {
                                                date: formatDate(
                                                    key.last_used_at,
                                                    locale,
                                                    i18n("Never"),
                                                    timeZone,
                                                ),
                                            })}
                                        </p>
                                    </div>
                                    <Button
                                        size="icon"
                                        variant="outline"
                                        aria-label={i18n("Disconnect {name}", {
                                            name: key.name,
                                        })}
                                        onClick={() => {
                                            const hasPendingCapture =
                                                status.pending_captures.some(
                                                    (capture) =>
                                                        capture.api_key_id ===
                                                        key.id,
                                                );
                                            if (hasPendingCapture) {
                                                setRevokeCandidate(key.id);
                                                return;
                                            }
                                            void revoke(key.id);
                                        }}
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </div>
                                {revokeCandidate === key.id && (
                                    <div className="space-y-2 text-xs">
                                        <p>
                                            {i18n(
                                                "This recorder has unfinished recordings. Disconnect it only after authorizing another recorder key for recovery.",
                                            )}
                                        </p>
                                        <div className="flex gap-2">
                                            <Button
                                                size="sm"
                                                variant="destructive"
                                                onClick={() =>
                                                    void revoke(key.id)
                                                }
                                            >
                                                {i18n("Disconnect anyway")}
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() =>
                                                    setRevokeCandidate(null)
                                                }
                                            >
                                                {i18n("Cancel")}
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </details>
            )}

            {mode === "settings" && status && (
                <details className="rounded-lg border px-3 py-2">
                    <summary className="cursor-pointer text-sm font-medium">
                        {i18n("Automatic recording")}
                    </summary>
                    <div className="mt-3 space-y-2 text-sm">
                        <p className="text-xs text-muted-foreground">
                            {i18n(
                                "Defaults this server sends to paired extensions. Users can change them in the extension's options unless locked.",
                            )}
                        </p>
                        <p>
                            {autoPlatformNames
                                ? i18n(
                                      "Automatic recording is on by default for: {platforms}.",
                                      { platforms: autoPlatformNames },
                                  )
                                : i18n(
                                      "No platform records automatically by default.",
                                  )}{" "}
                            {i18n(
                                "Recordings stop after {seconds} seconds of silence.",
                                {
                                    seconds: String(
                                        status.defaults.auto_stop_quiet_seconds,
                                    ),
                                },
                            )}
                            {status.defaults.lock_defaults && (
                                <>
                                    {" "}
                                    {i18n(
                                        "These defaults are locked by the server.",
                                    )}
                                </>
                            )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {i18n("Change with")}{" "}
                            <code>RECORDER_AUTO_RECORD_PLATFORMS</code>{" "}
                            {i18n("and related environment variables.")}
                        </p>
                    </div>
                </details>
            )}

            {mode === "settings" &&
                status &&
                status.pending_captures.length > 0 && (
                    <details className="rounded-lg border px-3 py-2">
                        <summary className="cursor-pointer text-sm font-medium">
                            {i18n("Recover unfinished recordings")}
                        </summary>
                        <div className="mt-3 space-y-3">
                            {status.pending_captures.map((capture) => (
                                <div
                                    key={capture.client_recording_id}
                                    className="space-y-2 rounded border p-2 text-sm"
                                >
                                    <NativeSelect
                                        className="h-8 w-full"
                                        aria-label={i18n("New recorder key")}
                                        value={
                                            rebindTargets[
                                                capture.client_recording_id
                                            ] ?? ""
                                        }
                                        onChange={(event) =>
                                            setRebindTargets((current) => ({
                                                ...current,
                                                [capture.client_recording_id]:
                                                    event.target.value,
                                            }))
                                        }
                                    >
                                        <option value="">
                                            {i18n(
                                                "Select another recorder key",
                                            )}
                                        </option>
                                        {status.keys
                                            .filter(
                                                (key) =>
                                                    key.id !==
                                                    capture.api_key_id,
                                            )
                                            .map((key) => (
                                                <option
                                                    key={key.id}
                                                    value={key.id}
                                                >
                                                    {key.name}
                                                </option>
                                            ))}
                                    </NativeSelect>
                                    <Button
                                        size="sm"
                                        disabled={
                                            !rebindTargets[
                                                capture.client_recording_id
                                            ]
                                        }
                                        onClick={() =>
                                            void rebind(
                                                capture.client_recording_id,
                                            )
                                        }
                                    >
                                        {i18n("Authorize recovery")}
                                    </Button>
                                </div>
                            ))}
                        </div>
                    </details>
                )}
        </div>
    );
}
