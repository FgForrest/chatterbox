"use client";

import {
    Check,
    Clipboard,
    Download,
    Plug,
    RefreshCw,
    Trash2,
    Video,
} from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { Button } from "@/components/ui/button";
import { getApiErrorMessage } from "@/lib/api-errors";
import {
    browserRecorderExtensionClient,
    type RecorderExtensionState,
} from "@/lib/recorder-extension/client";
import { RECORDER_EXTENSION_ID } from "@/lib/recorder-extension/extension-id";

type RecorderKey = {
    id: string;
    name: string;
    key_prefix: string;
    created_at: string;
    last_used_at: string | null;
};

type RecorderStatus = {
    keys: RecorderKey[];
    pending_captures: {
        client_recording_id: string;
        api_key_id: string;
        created_at: string;
        expires_at: string;
    }[];
    server_url: string | null;
    extension_id: string;
    defaults: {
        auto_record_platforms: string[];
        auto_stop_quiet_seconds: number;
        notice_text: string;
        lock_defaults: boolean;
    };
    platforms: { id: string; name: string }[];
};

type PairResponse = RecorderStatus & { key_id: string; api_key: string };

function formatDate(
    value: string | null,
    locale: string,
    never: string,
): string {
    if (!value) return never;
    return new Date(value).toLocaleString(locale);
}

/**
 * Meeting Recorder pairing card.
 *
 * Detects the browser extension from this page and, when it can reach it,
 * starts pairing: the server mints a `recordings:write` key, the page hands it
 * over, and the extension asks the user to confirm its destination. Where the extension is installed but cannot yet talk to
 * this origin (a self-hosted instance on first contact) the card explains the
 * one-time grant in the extension popup. Manual copy-paste stays available.
 */
export function RecorderSection() {
    const locale = useLocale();
    const i18n = useExtracted();
    const [extension, setExtension] = useState<RecorderExtensionState | null>(
        null,
    );
    const [status, setStatus] = useState<RecorderStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [manualKey, setManualKey] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [rebindTargets, setRebindTargets] = useState<Record<string, string>>(
        {},
    );
    const [revokeCandidate, setRevokeCandidate] = useState<string | null>(null);
    const clientRef = useRef<ReturnType<
        typeof browserRecorderExtensionClient
    > | null>(null);

    const detect = useCallback(async () => {
        if (!clientRef.current) {
            clientRef.current = browserRecorderExtensionClient();
        }
        const state = await clientRef.current.detect(RECORDER_EXTENSION_ID);
        setExtension(state);
        return state;
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
        void detect();
        void loadStatus();
        const client = browserRecorderExtensionClient();
        clientRef.current = client;
        const onFocus = () => void detect();
        window.addEventListener("focus", onFocus);
        // A popup-side grant injects the relay live; pick it up without a reload.
        const stopPresence = client.onPresence((state) => setExtension(state));
        return () => {
            window.removeEventListener("focus", onFocus);
            stopPresence();
        };
    }, [detect, loadStatus]);

    const mintKey = useCallback(async (): Promise<PairResponse> => {
        const response = await fetch("/api/settings/recorder/pair", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                label: navigator.platform || "browser",
                installationId:
                    extension?.kind === "reachable"
                        ? extension.installationId
                        : undefined,
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
    }, [i18n, extension]);

    const setUp = useCallback(async () => {
        if (
            !clientRef.current ||
            !extension ||
            extension.kind !== "reachable"
        ) {
            return;
        }
        setBusy(true);
        try {
            const minted = await mintKey();
            const serverUrl = minted.server_url ?? window.location.origin;
            const result = await clientRef.current.pair(
                RECORDER_EXTENSION_ID,
                extension.channel,
                { serverUrl, apiKey: minted.api_key },
            );
            if (!result.ok) {
                throw new Error(
                    result.error ?? i18n("The extension refused pairing"),
                );
            }
            toast.success(
                result.pending
                    ? i18n("Confirm the server in the extension's options page")
                    : i18n("Recorder connected"),
            );
            await Promise.all([detect(), loadStatus()]);
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : i18n("Pairing failed"),
            );
        } finally {
            setBusy(false);
        }
    }, [detect, extension, loadStatus, mintKey, i18n]);

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
    }, [loadStatus, mintKey, i18n]);

    const copyManual = useCallback(async () => {
        if (!manualKey) return;
        await navigator.clipboard.writeText(manualKey);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }, [manualKey]);

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
        [loadStatus, i18n],
    );

    const rebind = useCallback(
        async (clientRecordingId: string) => {
            const apiKeyId = rebindTargets[clientRecordingId];
            if (!apiKeyId) return;
            try {
                const response = await fetch("/api/settings/recorder/rebind", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ clientRecordingId, apiKeyId }),
                });
                if (!response.ok) {
                    throw new Error(
                        await getApiErrorMessage(
                            response,
                            i18n("Could not authorize capture recovery"),
                        ),
                    );
                }
                toast.success(
                    i18n(
                        "Recorder key updated. Retry the upload in the extension.",
                    ),
                );
                await loadStatus();
            } catch (error) {
                toast.error(
                    error instanceof Error
                        ? error.message
                        : i18n("Recovery failed"),
                );
            }
        },
        [rebindTargets, i18n, loadStatus],
    );

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
        <div className="space-y-6">
            <SettingsSectionHeader
                title={i18n("Meeting Recorder")}
                description={i18n(
                    "Record meeting audio in your browser and send it straight to Chatterbox for transcription.",
                )}
                icon={Video}
                action={
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void detect()}
                        aria-label={i18n("Re-check extension")}
                    >
                        <RefreshCw className="size-4" />
                        {i18n("Re-check")}
                    </Button>
                }
            />

            <SettingsCard title={i18n("Browser extension")} icon={Plug}>
                {extension === null && (
                    <p className="text-sm text-muted-foreground">
                        {i18n("Looking for the extension…")}
                    </p>
                )}

                {extension?.kind === "not-installed" && (
                    <div className="space-y-3">
                        <p className="text-sm">
                            {i18n(
                                "The Chatterbox Meeting Recorder extension is not installed in this browser.",
                            )}
                        </p>
                        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                            <li>
                                {i18n("Install the extension: load the")}{" "}
                                <code>extensions/recorder</code>{" "}
                                {i18n("unpacked, or use the packaged build.")}
                            </li>
                            <li>
                                {i18n("Come back here and click Re-check.")}
                            </li>
                        </ol>
                    </div>
                )}

                {extension?.kind === "installed-unreachable" && (
                    <div className="space-y-3">
                        <p className="text-sm">
                            {i18n(
                                "The extension is installed but cannot reach this Chatterbox yet. Chrome requires one permission grant.",
                            )}
                        </p>
                        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                            <li>
                                {i18n(
                                    "Click the Chatterbox Recorder icon in the toolbar.",
                                )}
                            </li>
                            <li>
                                {i18n("Choose")}{" "}
                                <strong>
                                    {i18n("Connect to")}{" "}
                                    {window.location.origin}
                                </strong>
                                .
                            </li>
                            <li>
                                {i18n(
                                    "This page will update automatically. Then click Set up recorder.",
                                )}
                            </li>
                        </ol>
                    </div>
                )}

                {extension?.kind === "reachable" && !extension.paired && (
                    <div className="space-y-3">
                        <p className="text-sm">
                            {i18n("Extension found")}
                            {extension.version
                                ? ` (v${extension.version})`
                                : ""}
                            {i18n(
                                ". Select Set up recorder, then confirm the server in the extension's options page.",
                            )}
                        </p>
                        <Button onClick={() => void setUp()} disabled={busy}>
                            <Plug className="size-4" />
                            {i18n("Set up recorder")}
                        </Button>
                    </div>
                )}

                {extension?.kind === "reachable" &&
                    extension.paired &&
                    extension.pairedHere && (
                        <p className="text-sm">
                            <Check className="mr-1 inline size-4 text-green-600" />
                            {i18n("Connected to this Chatterbox")}
                            {extension.version
                                ? ` (extension v${extension.version})`
                                : ""}
                            .
                        </p>
                    )}

                {extension?.kind === "reachable" &&
                    extension.paired &&
                    !extension.pairedHere && (
                        <div className="space-y-3">
                            <p className="text-sm">
                                {i18n(
                                    "The extension is connected to another Chatterbox",
                                )}
                                {extension.pairedTo
                                    ? ` (${extension.pairedTo})`
                                    : ""}
                                .
                            </p>
                            <Button
                                onClick={() => void setUp()}
                                disabled={busy}
                            >
                                <Plug className="size-4" />
                                {i18n("Switch it to this Chatterbox")}
                            </Button>
                        </div>
                    )}
            </SettingsCard>

            {status && status.keys.length > 0 && (
                <SettingsCard
                    title={i18n("Connected recorders")}
                    description={i18n(
                        "Each key is write-only: it can create recordings but cannot read your library.",
                    )}
                >
                    <div className="space-y-2">
                        {status.keys.map((key) => (
                            <div
                                key={key.id}
                                className="flex flex-col gap-2 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                            >
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-medium">
                                            {key.name}
                                        </span>
                                        <span className="rounded border px-2 py-0.5 font-mono text-xs text-muted-foreground">
                                            {key.key_prefix}
                                        </span>
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                        {i18n("Created")}{" "}
                                        {formatDate(
                                            key.created_at,
                                            locale,
                                            i18n("Never"),
                                        )}{" "}
                                        · {i18n("Last used")}{" "}
                                        {formatDate(
                                            key.last_used_at,
                                            locale,
                                            i18n("Never"),
                                        )}
                                    </div>
                                </div>
                                <Button
                                    variant="outline"
                                    size="icon"
                                    onClick={() => {
                                        if (
                                            status.pending_captures.some(
                                                (capture) =>
                                                    capture.api_key_id ===
                                                    key.id,
                                            )
                                        ) {
                                            setRevokeCandidate(key.id);
                                        } else {
                                            void revoke(key.id);
                                        }
                                    }}
                                    aria-label={i18n("Revoke {name}", {
                                        name: key.name,
                                    })}
                                >
                                    <Trash2 className="size-4 text-destructive" />
                                </Button>
                                {revokeCandidate === key.id && (
                                    <div className="space-y-2 text-xs">
                                        <p>
                                            {i18n(
                                                "This key has unfinished recordings. Revoke it only if you can rebind them to another recorder key.",
                                            )}
                                        </p>
                                        <Button
                                            size="sm"
                                            variant="destructive"
                                            onClick={() => {
                                                setRevokeCandidate(null);
                                                void revoke(key.id);
                                            }}
                                        >
                                            {i18n("Revoke anyway")}
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
                                )}
                            </div>
                        ))}
                    </div>
                </SettingsCard>
            )}

            {status && status.pending_captures.length > 0 && (
                <SettingsCard
                    title={i18n("Unfinished recorder captures")}
                    description={i18n(
                        "Encrypted browser chunks remain tied to their original recorder key until this account authorizes a new key. The extension keeps the chunks for upload recovery.",
                    )}
                >
                    <div className="space-y-3">
                        {status.pending_captures.map((capture) => (
                            <div
                                key={capture.client_recording_id}
                                className="rounded-lg border p-3 text-sm"
                            >
                                <p>
                                    {i18n("Started")}{" "}
                                    {formatDate(
                                        capture.created_at,
                                        locale,
                                        i18n("Never"),
                                    )}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {i18n("Recovery key expires")}{" "}
                                    {formatDate(
                                        capture.expires_at,
                                        locale,
                                        i18n("Never"),
                                    )}
                                </p>
                                <p className="text-xs font-mono break-all">
                                    {capture.client_recording_id}
                                </p>
                                <div className="mt-2 flex flex-wrap gap-2">
                                    <select
                                        aria-label={i18n("New recorder key")}
                                        className="rounded border bg-background px-2 py-1"
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
                                                    {key.name} ({key.key_prefix}
                                                    )
                                                </option>
                                            ))}
                                    </select>
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
                            </div>
                        ))}
                    </div>
                </SettingsCard>
            )}

            {status && (
                <SettingsCard
                    title={i18n("Automatic recording")}
                    description={i18n(
                        "Defaults this server sends to paired extensions. Users can change them in the extension's options unless locked.",
                    )}
                >
                    <p className="text-sm">
                        {autoPlatformNames
                            ? i18n(
                                  "Automatic recording is on by default for: {platforms}.",
                                  { platforms: autoPlatformNames },
                              )
                            : i18n(
                                  "No platform records automatically by default.",
                              )}{" "}
                        {i18n("Recordings stop after")}{" "}
                        {status.defaults.auto_stop_quiet_seconds}{" "}
                        {i18n("seconds of silence.")}
                        {status.defaults.lock_defaults
                            ? i18n(" These defaults are locked by the server.")
                            : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                        {i18n("Change with")}{" "}
                        <code>RECORDER_AUTO_RECORD_PLATFORMS</code>{" "}
                        {i18n("and related environment variables.")}
                    </p>
                </SettingsCard>
            )}

            <details className="rounded-lg border bg-card/40 px-4 py-3.5">
                <summary className="cursor-pointer text-sm font-medium">
                    {i18n("Manual setup")}
                </summary>
                <div className="mt-3 space-y-3">
                    <p className="text-xs text-muted-foreground">
                        {i18n(
                            "If automatic pairing is unavailable, generate a key here and paste it with the server URL",
                        )}{" "}
                        <code>
                            {status?.server_url ?? window.location.origin}
                        </code>
                        {i18n(" into the extension's options.")}
                    </p>
                    {manualKey ? (
                        <div className="space-y-2">
                            <div className="rounded-md border bg-muted p-3 font-mono text-sm break-all">
                                {manualKey}
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {i18n("Shown once. Copy it now.")}
                            </p>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => void copyManual()}
                            >
                                {copied ? (
                                    <Check className="size-4" />
                                ) : (
                                    <Clipboard className="size-4" />
                                )}
                                {i18n("Copy key")}
                            </Button>
                        </div>
                    ) : (
                        <Button
                            type="button"
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
        </div>
    );
}
