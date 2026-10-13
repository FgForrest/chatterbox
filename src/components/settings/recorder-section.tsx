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
import { useLocale } from "next-intl";
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

function formatDate(value: string | null, locale: string): string {
    if (!value) return locale.startsWith("cs") ? "Nikdy" : "Never";
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
    const t = useCallback(
        (english: string, czech: string) =>
            locale.startsWith("cs") ? czech : english,
        [locale],
    );
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
                        t(
                            "Failed to load recorder status",
                            "Nelze načíst stav nahrávání",
                        ),
                    ),
                );
            }
            setStatus((await response.json()) as RecorderStatus);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : t(
                          "Failed to load recorder status",
                          "Nelze načíst stav nahrávání",
                      ),
            );
        }
    }, [t]);

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
            body: JSON.stringify({ label: navigator.platform || "browser" }),
        });
        if (!response.ok) {
            throw new Error(
                await getApiErrorMessage(
                    response,
                    t(
                        "Failed to create recorder key",
                        "Nelze vytvořit klíč pro nahrávání",
                    ),
                ),
            );
        }
        return (await response.json()) as PairResponse;
    }, [t]);

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
                    result.error ??
                        t(
                            "The extension refused pairing",
                            "Rozšíření odmítlo propojení",
                        ),
                );
            }
            toast.success(
                result.pending
                    ? t(
                          "Confirm the server in the extension's options page",
                          "Potvrďte server v možnostech rozšíření",
                      )
                    : t("Recorder connected", "Nahrávání propojeno"),
            );
            await Promise.all([detect(), loadStatus()]);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : t("Pairing failed", "Propojení se nepodařilo"),
            );
        } finally {
            setBusy(false);
        }
    }, [detect, extension, loadStatus, mintKey, t]);

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
                    : t("Failed to create key", "Klíč nelze vytvořit"),
            );
        } finally {
            setBusy(false);
        }
    }, [loadStatus, mintKey, t]);

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
                            t("Failed to revoke", "Klíč nelze zrušit"),
                        ),
                    );
                }
                toast.success(
                    t("Recorder key revoked", "Klíč pro nahrávání zrušen"),
                );
                await loadStatus();
            } catch (error) {
                toast.error(
                    error instanceof Error
                        ? error.message
                        : t("Failed to revoke", "Klíč nelze zrušit"),
                );
            }
        },
        [loadStatus, t],
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
                title={t("Meeting Recorder", "Nahrávání schůzek")}
                description={t(
                    "Record meeting audio in your browser and send it straight to Chatterbox for transcription.",
                    "Nahrávejte zvuk schůzek v prohlížeči a posílejte ho do Klepny k přepisu.",
                )}
                icon={Video}
                action={
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void detect()}
                        aria-label={t(
                            "Re-check extension",
                            "Znovu zkontrolovat rozšíření",
                        )}
                    >
                        <RefreshCw className="size-4" />
                        {t("Re-check", "Zkontrolovat")}
                    </Button>
                }
            />

            <SettingsCard
                title={t("Browser extension", "Rozšíření prohlížeče")}
                icon={Plug}
            >
                {extension === null && (
                    <p className="text-sm text-muted-foreground">
                        {t("Looking for the extension…", "Hledá se rozšíření…")}
                    </p>
                )}

                {extension?.kind === "not-installed" && (
                    <div className="space-y-3">
                        <p className="text-sm">
                            {t(
                                "The Chatterbox Meeting Recorder extension is not installed in this browser.",
                                "Rozšíření Klepna pro nahrávání schůzek není v tomto prohlížeči nainstalované.",
                            )}
                        </p>
                        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                            <li>
                                {t(
                                    "Install the extension: load the",
                                    "Nainstalujte rozšíření: načtěte složku",
                                )}{" "}
                                <code>extensions/recorder</code>{" "}
                                {t(
                                    "unpacked, or use the packaged build.",
                                    "jako rozbalené rozšíření nebo použijte zabalenou verzi.",
                                )}
                            </li>
                            <li>
                                {t(
                                    "Come back here and click Re-check.",
                                    "Vraťte se sem a klikněte na Zkontrolovat.",
                                )}
                            </li>
                        </ol>
                    </div>
                )}

                {extension?.kind === "installed-unreachable" && (
                    <div className="space-y-3">
                        <p className="text-sm">
                            {t(
                                "The extension is installed but cannot reach this Chatterbox yet. Chrome requires one permission grant.",
                                "Rozšíření je nainstalované, ale zatím se s Klepnou nespojí. Chrome vyžaduje jednorázové povolení.",
                            )}
                        </p>
                        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                            <li>
                                {t(
                                    "Click the Chatterbox Recorder icon in the toolbar.",
                                    "Klikněte na ikonu Klepny na liště.",
                                )}
                            </li>
                            <li>
                                {t("Choose", "Zvolte")}{" "}
                                <strong>
                                    {t("Connect to", "Propojit s")}{" "}
                                    {window.location.origin}
                                </strong>
                                .
                            </li>
                            <li>
                                {t(
                                    "This page will update automatically. Then click Set up recorder.",
                                    "Stránka se sama aktualizuje. Potom klikněte na Nastavit nahrávání.",
                                )}
                            </li>
                        </ol>
                    </div>
                )}

                {extension?.kind === "reachable" && !extension.paired && (
                    <div className="space-y-3">
                        <p className="text-sm">
                            {t("Extension found", "Rozšíření nalezeno")}
                            {extension.version
                                ? ` (v${extension.version})`
                                : ""}
                            {t(
                                ". Select Set up recorder, then confirm the server in the extension's options page.",
                                ". Zvolte Nastavit nahrávání a potom potvrďte server v možnostech rozšíření.",
                            )}
                        </p>
                        <Button onClick={() => void setUp()} disabled={busy}>
                            <Plug className="size-4" />
                            {t("Set up recorder", "Nastavit nahrávání")}
                        </Button>
                    </div>
                )}

                {extension?.kind === "reachable" &&
                    extension.paired &&
                    extension.pairedHere && (
                        <p className="text-sm">
                            <Check className="mr-1 inline size-4 text-green-600" />
                            {t(
                                "Connected to this Chatterbox",
                                "Propojeno s touto Klepnou",
                            )}
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
                                {t(
                                    "The extension is connected to another Chatterbox",
                                    "Rozšíření je propojené s jinou Klepnou",
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
                                {t(
                                    "Switch it to this Chatterbox",
                                    "Přepojit na tuto Klepnu",
                                )}
                            </Button>
                        </div>
                    )}
            </SettingsCard>

            {status && status.keys.length > 0 && (
                <SettingsCard
                    title={t(
                        "Connected recorders",
                        "Propojená nahrávací zařízení",
                    )}
                    description={t(
                        "Each key is write-only: it can create recordings but cannot read your library.",
                        "Každý klíč slouží jen k zápisu: může vytvářet nahrávky, ale nemůže číst knihovnu.",
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
                                        {t("Created", "Vytvořeno")}{" "}
                                        {formatDate(key.created_at, locale)} ·{" "}
                                        {t("Last used", "Naposledy použito")}{" "}
                                        {formatDate(key.last_used_at, locale)}
                                    </div>
                                </div>
                                <Button
                                    variant="outline"
                                    size="icon"
                                    onClick={() => void revoke(key.id)}
                                    aria-label={`${t("Revoke", "Zrušit")} ${key.name}`}
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
                    title={t("Automatic recording", "Automatické nahrávání")}
                    description={t(
                        "Defaults this server sends to paired extensions. Users can change them in the extension's options unless locked.",
                        "Výchozí hodnoty, které server posílá propojeným rozšířením. Pokud nejsou uzamčené, lze je změnit v možnostech rozšíření.",
                    )}
                >
                    <p className="text-sm">
                        {autoPlatformNames
                            ? t(
                                  `Automatic recording is on by default for: ${autoPlatformNames}.`,
                                  `Automatické nahrávání je ve výchozím stavu zapnuté pro: ${autoPlatformNames}.`,
                              )
                            : t(
                                  "No platform records automatically by default.",
                                  "Ve výchozím stavu se žádná platforma nenahrává automaticky.",
                              )}{" "}
                        {t("Recordings stop after", "Nahrávání se zastaví po")}{" "}
                        {status.defaults.auto_stop_quiet_seconds}{" "}
                        {t("seconds of silence.", "sekundách ticha.")}
                        {status.defaults.lock_defaults
                            ? t(
                                  " These defaults are locked by the server.",
                                  " Tyto výchozí hodnoty jsou uzamčené serverem.",
                              )
                            : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                        {t("Change with", "Změňte pomocí")}{" "}
                        <code>RECORDER_AUTO_RECORD_PLATFORMS</code>{" "}
                        {t(
                            "and related environment variables.",
                            "a souvisejících proměnných prostředí.",
                        )}
                    </p>
                </SettingsCard>
            )}

            <details className="rounded-lg border bg-card/40 px-4 py-3.5">
                <summary className="cursor-pointer text-sm font-medium">
                    {t("Manual setup", "Ruční nastavení")}
                </summary>
                <div className="mt-3 space-y-3">
                    <p className="text-xs text-muted-foreground">
                        {t(
                            "If automatic pairing is unavailable, generate a key here and paste it with the server URL",
                            "Pokud automatické propojení není dostupné, vytvořte zde klíč a vložte ho spolu s adresou serveru",
                        )}{" "}
                        <code>
                            {status?.server_url ?? window.location.origin}
                        </code>
                        {t(
                            " into the extension's options.",
                            " do možností rozšíření.",
                        )}
                    </p>
                    {manualKey ? (
                        <div className="space-y-2">
                            <div className="rounded-md border bg-muted p-3 font-mono text-sm break-all">
                                {manualKey}
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {t(
                                    "Shown once. Copy it now.",
                                    "Zobrazí se pouze jednou. Zkopírujte ho nyní.",
                                )}
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
                                {t("Copy key", "Kopírovat klíč")}
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
                            {t(
                                "Generate recorder key",
                                "Vytvořit klíč pro nahrávání",
                            )}
                        </Button>
                    )}
                </div>
            </details>
        </div>
    );
}
