"use client";

import { RefreshCw, Search, ShieldCheck } from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm-dialog";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { type ApiErrorBody, parseApiError } from "@/lib/api-errors";
import { signIn } from "@/lib/auth-client";
import { CAPABILITIES, type Capability } from "@/lib/authz/catalog";
import { formatDateTime } from "@/lib/format-date";
import { SSO_PROVIDER_ID } from "@/lib/sso/constants";

type Source = "direct-role" | "other-group" | "parent-group" | "composite";

interface LocalAccount {
    userId: string;
    email: string;
    name: string | null;
    lastSsoLoginAt: string | null;
}

interface AccessRow {
    subject: string;
    username: string | null;
    email: string | null;
    name: string | null;
    enabled: boolean;
    effective: Capability[];
    managed: Capability[];
    local: LocalAccount | null;
}

interface AccessDetail extends AccessRow {
    inherited: { capability: Capability; sources: Source[] }[];
    revision: string;
    self: boolean;
}

interface HistoryEntry {
    at: string;
    correlationId: string;
    action: "change" | "revoke-sessions";
    requested: { add?: Capability[]; remove?: Capability[] };
    outcome: string;
    revocation: "not-needed" | "done" | "pending" | "failed";
}

type PendingRevocation = Pick<
    AccessRow,
    "subject" | "username" | "email" | "name"
>;

interface ChangeOutcome {
    status: "applied" | "partial" | "noop";
    failed: { capability: Capability; error: string }[];
    stillEffective: { capability: Capability; sources: Source[] }[];
    revocation: "not-needed" | "done" | "pending" | "failed";
    access: AccessDetail;
}

function personLabel(
    row: Pick<AccessRow, "name" | "email" | "username" | "subject">,
) {
    return row.name ?? row.email ?? row.username ?? row.subject;
}

/**
 * Settings -> Access: who may use Chatterbox, curate the Organization and
 * manage access, as the identity provider holds it. Changes write the
 * provider's groups with the administrator's own sign-in; the server
 * re-checks everything this screen shows.
 */
export function AccessSection() {
    const i18n = useExtracted();
    const locale = useLocale();
    const confirm = useConfirm();
    const [search, setSearch] = useState("");
    const [query, setQuery] = useState("");
    const [page, setPage] = useState(0);
    const [rows, setRows] = useState<AccessRow[] | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [listError, setListError] = useState<string | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [detail, setDetail] = useState<AccessDetail | null>(null);
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [unfinished, setUnfinished] = useState<PendingRevocation[]>([]);
    const [busy, setBusy] = useState(false);
    const [reauthenticationRequired, setReauthenticationRequired] =
        useState(false);

    const capabilityName = (capability: Capability) => {
        switch (capability) {
            case "use":
                return i18n("Access to Chatterbox");
            case "org.curate":
                return i18n("Curates the Organization");
            case "access.manage":
                return i18n("Manages access");
        }
    };
    const sourceName = (source: Source) => {
        switch (source) {
            case "direct-role":
                return i18n("a role assigned directly");
            case "other-group":
                return i18n("another group");
            case "parent-group":
                return i18n("a subgroup");
            case "composite":
                return i18n("a composite role");
        }
    };
    const outcomeName = (outcome: string) => {
        switch (outcome) {
            case "pending":
                return i18n("unfinished");
            case "applied":
                return i18n("done");
            case "noop":
                return i18n("nothing to change");
            case "partial":
                return i18n("partly done");
            case "inherited":
                return i18n("still granted elsewhere");
            case "denied":
                return i18n("refused: not an administrator");
            case "provider-denied":
                return i18n("refused by the identity provider");
            case "stale":
                return i18n("refused: changed meanwhile");
            case "self-lockout":
                return i18n("refused: your own access");
            case "reauth-required":
                return i18n("refused: sign in again");
            case "error":
                return i18n("failed");
            default:
                return outcome;
        }
    };

    const explain = useCallback(
        (body: ApiErrorBody): string => {
            switch (body.code) {
                case "CAPABILITY_REQUIRED":
                    return i18n(
                        "You are not an administrator of access to Chatterbox.",
                    );
                case "PROVIDER_DENIED":
                    return i18n(
                        "The identity provider refused this change for your account. Ask your IT department to grant the delegated administration.",
                    );
                case "REAUTHENTICATION_REQUIRED":
                    setReauthenticationRequired(true);
                    return i18n("Sign in again to manage access.");
                case "ACCESS_INHERITED":
                    return i18n(
                        "This access is granted elsewhere at the identity provider and cannot be switched off here.",
                    );
                case "ACCESS_STALE":
                    return i18n(
                        "This person's access changed meanwhile. The current state is shown; try again.",
                    );
                case "ACCESS_LOCKOUT":
                    return i18n(
                        "You cannot take away your own access or administration.",
                    );
                case "SERVICE_UNAVAILABLE":
                    return i18n(
                        "The identity provider is unavailable. Try again shortly.",
                    );
                default:
                    return body.error;
            }
        },
        [i18n],
    );

    const loadList = useCallback(async () => {
        setListError(null);
        const params = new URLSearchParams({ page: String(page) });
        if (query) params.set("search", query);
        const response = await fetch(`/api/access/subjects?${params}`);
        if (!response.ok) {
            setRows([]);
            setListError(explain(await parseApiError(response)));
            return;
        }
        const body = (await response.json()) as {
            rows: AccessRow[];
            hasMore: boolean;
        };
        setRows(body.rows);
        setHasMore(body.hasMore);
    }, [explain, page, query]);

    const loadDetail = useCallback(
        async (subject: string) => {
            const response = await fetch(
                `/api/access/subjects/${encodeURIComponent(subject)}`,
            );
            if (!response.ok) {
                toast.error(explain(await parseApiError(response)));
                setDetail(null);
                return;
            }
            const body = (await response.json()) as {
                access: AccessDetail;
                history: HistoryEntry[];
            };
            setDetail(body.access);
            setHistory(body.history);
        },
        [explain],
    );

    const loadUnfinished = useCallback(async () => {
        const response = await fetch("/api/access/pending-revocations");
        if (!response.ok) return;
        const body = (await response.json()) as {
            people: PendingRevocation[];
        };
        setUnfinished(body.people);
    }, []);

    useEffect(() => {
        void loadList();
    }, [loadList]);

    useEffect(() => {
        void loadUnfinished();
    }, [loadUnfinished]);

    useEffect(() => {
        if (selected) void loadDetail(selected);
    }, [loadDetail, selected]);

    const reportRevocation = (revocation: ChangeOutcome["revocation"]) => {
        if (revocation === "pending" || revocation === "failed") {
            toast.warning(
                i18n(
                    "The change is saved, but ending this person's sessions at the identity provider is still pending. Retry below.",
                ),
            );
        }
    };

    const applyChange = async (
        current: AccessDetail,
        capability: Capability,
        grant: boolean,
    ) => {
        setBusy(true);
        try {
            const response = await fetch(
                `/api/access/subjects/${encodeURIComponent(current.subject)}`,
                {
                    method: "PATCH",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        ...(grant
                            ? { add: [capability] }
                            : { remove: [capability] }),
                        revision: current.revision,
                    }),
                },
            );
            if (!response.ok) {
                const body = await parseApiError(response);
                toast.error(explain(body));
                const fresh = body.details?.access as AccessDetail | undefined;
                if (fresh) setDetail(fresh);
                else await loadDetail(current.subject);
                return;
            }
            const outcome = (await response.json()) as ChangeOutcome;
            setDetail(outcome.access);
            if (outcome.status === "partial") {
                toast.warning(
                    i18n(
                        "Only part of the change was saved. The current state is shown; try the rest again.",
                    ),
                );
            } else if (outcome.stillEffective.length > 0) {
                toast.warning(
                    i18n(
                        "The managed group was removed, but the access is still granted elsewhere at the identity provider.",
                    ),
                );
            } else if (outcome.status === "applied") {
                toast.success(i18n("Access changed"));
            }
            reportRevocation(outcome.revocation);
            await Promise.all([
                loadDetail(current.subject),
                loadList(),
                loadUnfinished(),
            ]);
        } finally {
            setBusy(false);
        }
    };

    const toggle = async (
        current: AccessDetail,
        capability: Capability,
        grant: boolean,
    ) => {
        if (!grant && capability === "use") {
            await confirm({
                title: i18n("Take away access to Chatterbox?"),
                description: i18n(
                    "{person} is signed out everywhere at once, and their API keys and recorder stop working until access is given back.",
                    { person: personLabel(current) },
                ),
                confirmLabel: i18n("Take away access"),
                destructive: true,
                onConfirm: () => applyChange(current, capability, grant),
            });
            return;
        }
        await applyChange(current, capability, grant);
    };

    const retryRevocation = async (current: AccessDetail) => {
        setBusy(true);
        try {
            const response = await fetch(
                `/api/access/subjects/${encodeURIComponent(current.subject)}/revoke-sessions`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{}",
                },
            );
            if (!response.ok) {
                toast.error(explain(await parseApiError(response)));
                return;
            }
            const body = (await response.json()) as {
                revocation: ChangeOutcome["revocation"];
            };
            if (body.revocation === "done") {
                toast.success(i18n("Sessions ended"));
            } else {
                reportRevocation(body.revocation);
            }
            await Promise.all([loadDetail(current.subject), loadUnfinished()]);
        } finally {
            setBusy(false);
        }
    };

    // The newest entry that ended sessions, or tried to; history is newest first.
    const lastRevocation = history.find(
        (entry) => entry.revocation !== "not-needed",
    );
    const pendingRevocation =
        (lastRevocation?.revocation === "pending" ||
            lastRevocation?.revocation === "failed") &&
        detail !== null &&
        !detail.effective.includes("use");
    const sessionsOpen = new Set(unfinished.map((person) => person.subject));

    return (
        <div className="space-y-4">
            <SettingsSectionHeader
                title={i18n("Access")}
                icon={ShieldCheck}
                description={i18n(
                    "Who may use Chatterbox, curate the Organization and manage access. The identity provider keeps these rights; changes here take effect there.",
                )}
            />

            {reauthenticationRequired && (
                <Button
                    disabled={busy}
                    onClick={async () => {
                        setBusy(true);
                        try {
                            const result = await signIn.oauth2({
                                providerId: SSO_PROVIDER_ID,
                                callbackURL: new URL(
                                    "/settings#access",
                                    window.location.origin,
                                ).href,
                                errorCallbackURL: "/login",
                                additionalData: { reauthenticate: true },
                            });
                            if (result.error)
                                toast.error(
                                    result.error.message ??
                                        i18n("Sign in again to manage access."),
                                );
                        } catch {
                            toast.error(
                                i18n("Sign in again to manage access."),
                            );
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    {i18n("Sign in again to manage access.")}
                </Button>
            )}
            {unfinished.length > 0 && (
                <div className="space-y-2 rounded-md border border-amber-500/40 px-3 py-2">
                    <p className="text-sm">
                        {i18n(
                            "Access was taken away, but these people's sessions at the identity provider are still open. Open a person to end them.",
                        )}
                    </p>
                    <div className="flex flex-wrap gap-2">
                        {unfinished.map((person) => (
                            <Button
                                key={person.subject}
                                size="sm"
                                variant="outline"
                                onClick={() => setSelected(person.subject)}
                            >
                                {personLabel(person)}
                            </Button>
                        ))}
                    </div>
                </div>
            )}
            <form
                className="flex gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    setPage(0);
                    setQuery(search.trim());
                }}
            >
                <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={i18n("Search by name, email or username")}
                    aria-label={i18n("Search people")}
                />
                <Button type="submit" variant="outline">
                    <Search className="size-4" />
                    {i18n("Search")}
                </Button>
            </form>

            {listError && (
                <p role="alert" className="text-sm text-destructive">
                    {listError}
                </p>
            )}

            <SettingsCard>
                {rows === null ? (
                    <p className="text-sm text-muted-foreground">
                        {i18n("Loading...")}
                    </p>
                ) : rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {i18n("Nobody found.")}
                    </p>
                ) : (
                    <ul className="divide-y">
                        {rows.map((row) => (
                            <li key={row.subject}>
                                <button
                                    type="button"
                                    className="flex w-full items-center justify-between gap-3 py-2 text-left"
                                    aria-pressed={selected === row.subject}
                                    onClick={() => setSelected(row.subject)}
                                >
                                    <span className="min-w-0">
                                        <span className="block truncate text-sm font-medium">
                                            {personLabel(row)}
                                        </span>
                                        <span className="block truncate text-xs text-muted-foreground">
                                            {[
                                                row.email,
                                                row.local
                                                    ? null
                                                    : i18n("not signed in yet"),
                                                row.enabled
                                                    ? null
                                                    : i18n(
                                                          "disabled at the identity provider",
                                                      ),
                                            ]
                                                .filter(Boolean)
                                                .join(" · ")}
                                        </span>
                                    </span>
                                    <span className="flex shrink-0 flex-wrap justify-end gap-1">
                                        {sessionsOpen.has(row.subject) && (
                                            <span className="rounded border border-amber-500/40 px-1.5 py-0.5 text-xs">
                                                {i18n("Sessions still open")}
                                            </span>
                                        )}
                                        {row.effective.map((capability) => (
                                            <span
                                                key={capability}
                                                className="rounded border px-1.5 py-0.5 text-xs"
                                            >
                                                {capabilityName(capability)}
                                            </span>
                                        ))}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                <div className="flex justify-between pt-3">
                    <Button
                        variant="ghost"
                        size="sm"
                        disabled={page === 0}
                        onClick={() =>
                            setPage((value) => Math.max(0, value - 1))
                        }
                    >
                        {i18n("Previous")}
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        disabled={!hasMore}
                        onClick={() => setPage((value) => value + 1)}
                    >
                        {i18n("Next")}
                    </Button>
                </div>
            </SettingsCard>

            {detail && (
                <SettingsCard
                    title={personLabel(detail)}
                    description={detail.email ?? detail.username ?? undefined}
                    action={
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={i18n("Reload")}
                            onClick={() => void loadDetail(detail.subject)}
                        >
                            <RefreshCw className="size-4" />
                        </Button>
                    }
                >
                    <div className="space-y-3">
                        {!detail.enabled && (
                            <p className="text-sm text-destructive">
                                {i18n(
                                    "This account is disabled at the identity provider.",
                                )}
                            </p>
                        )}
                        {!detail.effective.includes("use") &&
                            detail.effective.length > 0 && (
                                <p className="text-sm text-muted-foreground">
                                    {i18n(
                                        "Without access to Chatterbox the other rights are kept but cannot be used.",
                                    )}
                                </p>
                            )}
                        {CAPABILITIES.map((capability) => {
                            const inherited = detail.inherited.find(
                                (entry) => entry.capability === capability,
                            );
                            const managed = detail.managed.includes(capability);
                            const ownLockout =
                                detail.self &&
                                managed &&
                                (capability === "use" ||
                                    capability === "access.manage");
                            const locked = Boolean(inherited) && !managed;
                            return (
                                <div
                                    key={capability}
                                    className="flex items-start justify-between gap-4"
                                >
                                    <div className="min-w-0">
                                        <div className="text-sm">
                                            {capabilityName(capability)}
                                        </div>
                                        {inherited && (
                                            <div className="text-xs text-muted-foreground">
                                                {i18n(
                                                    "Also granted through {sources}; switching it off here does not remove it.",
                                                    {
                                                        sources:
                                                            inherited.sources
                                                                .map(sourceName)
                                                                .join(", "),
                                                    },
                                                )}
                                            </div>
                                        )}
                                        {ownLockout && (
                                            <div className="text-xs text-muted-foreground">
                                                {i18n(
                                                    "You cannot take this from yourself.",
                                                )}
                                            </div>
                                        )}
                                    </div>
                                    <Switch
                                        checked={managed || locked}
                                        disabled={busy || locked || ownLockout}
                                        aria-label={capabilityName(capability)}
                                        onCheckedChange={(checked) =>
                                            void toggle(
                                                detail,
                                                capability,
                                                checked,
                                            )
                                        }
                                    />
                                </div>
                            );
                        })}
                        <p className="text-xs text-muted-foreground">
                            {detail.local
                                ? i18n("Last signed in {date}", {
                                      date: detail.local.lastSsoLoginAt
                                          ? formatDateTime(
                                                detail.local.lastSsoLoginAt,
                                                "relative",
                                                locale,
                                            )
                                          : i18n("never"),
                                  })
                                : i18n(
                                      "Has not signed in to Chatterbox yet; the rights apply from the first sign-in.",
                                  )}
                        </p>
                        {pendingRevocation && !detail.self && (
                            <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/40 px-3 py-2">
                                <p className="text-sm">
                                    {i18n(
                                        "Rights are saved; ending the sessions at the identity provider is pending.",
                                    )}
                                </p>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={busy}
                                    onClick={() => void retryRevocation(detail)}
                                >
                                    {i18n("End sessions")}
                                </Button>
                            </div>
                        )}
                        {history.length > 0 && (
                            <details>
                                <summary className="cursor-pointer text-sm">
                                    {i18n("History")}
                                </summary>
                                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                                    {history.map((entry) => (
                                        <li
                                            key={`${entry.correlationId}-${entry.at}`}
                                        >
                                            {formatDateTime(
                                                entry.at,
                                                "absolute",
                                                locale,
                                            )}{" "}
                                            ·{" "}
                                            {entry.action === "revoke-sessions"
                                                ? i18n("sessions ended")
                                                : [
                                                      ...(
                                                          entry.requested.add ??
                                                          []
                                                      ).map(
                                                          (c) =>
                                                              `+${capabilityName(c)}`,
                                                      ),
                                                      ...(
                                                          entry.requested
                                                              .remove ?? []
                                                      ).map(
                                                          (c) =>
                                                              `−${capabilityName(c)}`,
                                                      ),
                                                  ].join(", ")}{" "}
                                            · {outcomeName(entry.outcome)}
                                        </li>
                                    ))}
                                </ul>
                            </details>
                        )}
                    </div>
                </SettingsCard>
            )}
        </div>
    );
}
