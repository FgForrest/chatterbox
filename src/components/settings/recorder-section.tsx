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

function formatDate(value: string | null): string {
    if (!value) return "Never";
    return new Date(value).toLocaleString();
}

/**
 * Meeting Recorder pairing card.
 *
 * Detects the browser extension from this page and, when it can reach it,
 * pairs it with one click: the server mints a `recordings:write` key and the
 * page hands it over. Where the extension is installed but cannot yet talk to
 * this origin (a self-hosted instance on first contact) the card explains the
 * one-time grant in the extension popup. Manual copy-paste stays available.
 */
export function RecorderSection() {
    const [extension, setExtension] = useState<RecorderExtensionState | null>(
        null,
    );
    const [status, setStatus] = useState<RecorderStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [manualKey, setManualKey] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
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
                        "Failed to load recorder status",
                    ),
                );
            }
            setStatus((await response.json()) as RecorderStatus);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to load recorder status",
            );
        }
    }, []);

    useEffect(() => {
        void detect();
        void loadStatus();
        const client = browserRecorderExtensionClient();
        clientRef.current = client;
        // A popup-side grant injects the relay live; pick it up without a reload.
        return client.onPresence((state) => setExtension(state));
    }, [detect, loadStatus]);

    const mintKey = useCallback(async (): Promise<PairResponse> => {
        const response = await fetch("/api/settings/recorder/pair", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ label: navigator.platform || "browser" }),
        });
        if (!response.ok) {
            throw new Error(
                await getApiErrorMessage(
                    response,
                    "Failed to create recorder key",
                ),
            );
        }
        return (await response.json()) as PairResponse;
    }, []);

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
                    result.error ?? "The extension refused pairing",
                );
            }
            toast.success("Recorder connected");
            await Promise.all([detect(), loadStatus()]);
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : "Pairing failed",
            );
        } finally {
            setBusy(false);
        }
    }, [detect, extension, loadStatus, mintKey]);

    const generateManual = useCallback(async () => {
        setBusy(true);
        try {
            const minted = await mintKey();
            setManualKey(minted.api_key);
            await loadStatus();
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : "Failed to create key",
            );
        } finally {
            setBusy(false);
        }
    }, [loadStatus, mintKey]);

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
                        await getApiErrorMessage(response, "Failed to revoke"),
                    );
                }
                toast.success("Recorder key revoked");
                await loadStatus();
            } catch (error) {
                toast.error(
                    error instanceof Error ? error.message : "Failed to revoke",
                );
            }
        },
        [loadStatus],
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
                title="Meeting Recorder"
                description="Record meeting audio in your browser and send it straight to Riffado for transcription."
                icon={Video}
                action={
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void detect()}
                        aria-label="Re-check extension"
                    >
                        <RefreshCw className="size-4" />
                        Re-check
                    </Button>
                }
            />

            <SettingsCard title="Browser extension" icon={Plug}>
                {extension === null && (
                    <p className="text-sm text-muted-foreground">
                        Looking for the extension…
                    </p>
                )}

                {extension?.kind === "not-installed" && (
                    <div className="space-y-3">
                        <p className="text-sm">
                            The Riffado Meeting Recorder extension is not
                            installed in this browser.
                        </p>
                        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                            <li>
                                Install the extension (load the{" "}
                                <code>extensions/recorder</code> folder
                                unpacked, or the packaged build).
                            </li>
                            <li>Come back here and click Re-check.</li>
                        </ol>
                    </div>
                )}

                {extension?.kind === "installed-unreachable" && (
                    <div className="space-y-3">
                        <p className="text-sm">
                            The extension is installed but cannot talk to this
                            Riffado yet. Chrome requires you to allow it once.
                        </p>
                        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                            <li>
                                Click the Riffado Recorder icon in the toolbar.
                            </li>
                            <li>
                                Choose{" "}
                                <strong>
                                    Connect to {window.location.origin}
                                </strong>
                                .
                            </li>
                            <li>
                                This page will update by itself; then click Set
                                up recorder.
                            </li>
                        </ol>
                    </div>
                )}

                {extension?.kind === "reachable" && !extension.paired && (
                    <div className="space-y-3">
                        <p className="text-sm">
                            Extension found
                            {extension.version
                                ? ` (v${extension.version})`
                                : ""}
                            . One click connects it to this Riffado.
                        </p>
                        <Button onClick={() => void setUp()} disabled={busy}>
                            <Plug className="size-4" />
                            Set up recorder
                        </Button>
                    </div>
                )}

                {extension?.kind === "reachable" &&
                    extension.paired &&
                    extension.pairedHere && (
                        <p className="text-sm">
                            <Check className="mr-1 inline size-4 text-green-600" />
                            Connected to this Riffado
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
                                The extension is connected to another Riffado
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
                                Switch it to this Riffado
                            </Button>
                        </div>
                    )}
            </SettingsCard>

            {status && status.keys.length > 0 && (
                <SettingsCard
                    title="Connected recorders"
                    description="Each key is write-only: it can create recordings but cannot read your library."
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
                                        Created {formatDate(key.created_at)} ·
                                        Last used {formatDate(key.last_used_at)}
                                    </div>
                                </div>
                                <Button
                                    variant="outline"
                                    size="icon"
                                    onClick={() => void revoke(key.id)}
                                    aria-label={`Revoke ${key.name}`}
                                >
                                    <Trash2 className="size-4 text-destructive" />
                                </Button>
                            </div>
                        ))}
                    </div>
                </SettingsCard>
            )}

            {status && (
                <SettingsCard
                    title="Automatic recording"
                    description="Defaults this server pushes to paired extensions. Users can change them in the extension's options unless locked."
                >
                    <p className="text-sm">
                        {autoPlatformNames
                            ? `Automatic recording is on by default for: ${autoPlatformNames}.`
                            : "No platform records automatically by default."}{" "}
                        Recordings stop after{" "}
                        {status.defaults.auto_stop_quiet_seconds} seconds of
                        silence.
                        {status.defaults.lock_defaults
                            ? " These defaults are locked by the server."
                            : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                        Change with <code>RECORDER_AUTO_RECORD_PLATFORMS</code>{" "}
                        and related environment variables.
                    </p>
                </SettingsCard>
            )}

            <details className="rounded-lg border bg-card/40 px-4 py-3.5">
                <summary className="cursor-pointer text-sm font-medium">
                    Manual setup
                </summary>
                <div className="mt-3 space-y-3">
                    <p className="text-xs text-muted-foreground">
                        If automatic pairing is not possible, generate a key
                        here and paste it, with the server URL{" "}
                        <code>
                            {status?.server_url ?? window.location.origin}
                        </code>
                        , into the extension's options.
                    </p>
                    {manualKey ? (
                        <div className="space-y-2">
                            <div className="rounded-md border bg-muted p-3 font-mono text-sm break-all">
                                {manualKey}
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Shown once. Copy it now.
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
                                Copy key
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
                            Generate recorder key
                        </Button>
                    )}
                </div>
            </details>
        </div>
    );
}
