"use client";

import {
    Archive,
    ChevronLeft,
    ChevronRight,
    Copy,
    FileAudio,
    Mail,
    Pencil,
    Plus,
    Star,
} from "lucide-react";
import { useExtracted } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ProfileEditor } from "@/components/settings/profile-editor";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ProfileChannel } from "@/lib/profiles/settings";
import type {
    SettingsProfileSummary,
    SettingsProfilesPage,
} from "@/types/settings";

const PAGE_SIZE = 10;

interface EditorTarget {
    profileId: string | null;
    newChannel?: ProfileChannel;
}

function errorMessage(body: unknown, fallback: string): string {
    if (
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string"
    ) {
        return body.error;
    }
    return fallback;
}

export function ProfilesSection() {
    const i18n = useExtracted();
    const [search, setSearch] = useState("");
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [channel, setChannel] = useState<"all" | ProfileChannel>("all");
    const [scope, setScope] = useState<"all" | "personal" | "organization">(
        "all",
    );
    const [page, setPage] = useState(1);
    const [data, setData] = useState<SettingsProfilesPage | null>(null);
    const [loading, setLoading] = useState(true);
    const [editor, setEditor] = useState<EditorTarget | null>(null);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setDebouncedSearch(search.trim());
            setPage(1);
        }, 250);
        return () => window.clearTimeout(timer);
    }, [search]);

    const query = useMemo(() => {
        const params = new URLSearchParams();
        if (debouncedSearch) params.set("q", debouncedSearch);
        if (channel !== "all") params.set("channel", channel);
        if (scope !== "all") params.set("scope", scope);
        params.set("page", String(page));
        params.set("pageSize", String(PAGE_SIZE));
        return params.toString();
    }, [channel, debouncedSearch, page, scope]);

    const loadProfiles = useCallback(async () => {
        setLoading(true);
        try {
            const response = await fetch(`/api/settings/profiles?${query}`);
            if (!response.ok) throw new Error("load");
            setData((await response.json()) as SettingsProfilesPage);
        } catch {
            toast.error(i18n("Failed to load profiles."));
        } finally {
            setLoading(false);
        }
    }, [i18n, query]);

    useEffect(() => {
        void loadProfiles();
    }, [loadProfiles]);

    const mutate = async (
        profile: SettingsProfileSummary,
        action: "duplicate" | "default" | "archive",
    ) => {
        const previous = data;
        if (action === "default") {
            setData((current) =>
                current
                    ? {
                          ...current,
                          profiles: current.profiles.map((item) =>
                              item.channel === profile.channel &&
                              item.scope === profile.scope
                                  ? {
                                        ...item,
                                        isDefault: item.id === profile.id,
                                    }
                                  : item,
                          ),
                      }
                    : current,
            );
        } else if (action === "archive") {
            setData((current) =>
                current
                    ? {
                          ...current,
                          profiles: current.profiles.filter(
                              (item) => item.id !== profile.id,
                          ),
                          pagination: {
                              ...current.pagination,
                              total: Math.max(0, current.pagination.total - 1),
                          },
                      }
                    : current,
            );
        }

        const endpoint =
            action === "duplicate"
                ? `/api/settings/profiles/${encodeURIComponent(profile.id)}/duplicate`
                : action === "default"
                  ? `/api/settings/profiles/${encodeURIComponent(profile.id)}/default`
                  : `/api/settings/profiles/${encodeURIComponent(profile.id)}`;
        try {
            const response = await fetch(endpoint, {
                method: action === "archive" ? "DELETE" : "POST",
                ...(action === "duplicate"
                    ? {
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({}),
                      }
                    : {}),
            });
            if (!response.ok) {
                const body = await response.json().catch(() => null);
                throw new Error(
                    errorMessage(body, i18n("Failed to update profile.")),
                );
            }
            toast.success(
                action === "duplicate"
                    ? i18n("Profile duplicated.")
                    : action === "default"
                      ? i18n("Default profile changed.")
                      : i18n("Profile archived."),
            );
            await loadProfiles();
        } catch (error) {
            if (previous) setData(previous);
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Failed to update profile."),
            );
        }
    };

    const profiles = data?.profiles ?? [];
    const pagination = data?.pagination;
    const closeEditor = useCallback((open: boolean) => {
        if (!open) setEditor(null);
    }, []);
    const refreshAfterSave = useCallback(() => {
        void loadProfiles();
    }, [loadProfiles]);

    return (
        <div className="space-y-5">
            <SettingsSectionHeader
                title={i18n("Profiles")}
                description={i18n(
                    "Choose how recordings and mail are transcribed, learned from, titled, summarized, and turned into tasks.",
                )}
                icon={FileAudio}
                action={
                    <div className="flex flex-wrap justify-end gap-2">
                        <Button
                            type="button"
                            size="sm"
                            onClick={() =>
                                setEditor({
                                    profileId: null,
                                    newChannel: "audio",
                                })
                            }
                        >
                            <Plus className="mr-1 size-4" aria-hidden="true" />
                            {i18n("New profile for recordings")}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                                setEditor({
                                    profileId: null,
                                    newChannel: "mail",
                                })
                            }
                        >
                            <Plus className="mr-1 size-4" aria-hidden="true" />
                            {i18n("New profile for mail")}
                        </Button>
                    </div>
                }
            />

            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                <Input
                    type="search"
                    aria-label={i18n("Search profiles")}
                    placeholder={i18n("Search profiles")}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                />
                <select
                    aria-label={i18n("Channel")}
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={channel}
                    onChange={(event) => {
                        setChannel(
                            event.target.value as "all" | ProfileChannel,
                        );
                        setPage(1);
                    }}
                >
                    <option value="all">{i18n("All channels")}</option>
                    <option value="audio">{i18n("For recordings")}</option>
                    <option value="mail">{i18n("For mail")}</option>
                </select>
                <select
                    aria-label={i18n("Scope")}
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={scope}
                    onChange={(event) => {
                        setScope(
                            event.target.value as
                                | "all"
                                | "personal"
                                | "organization",
                        );
                        setPage(1);
                    }}
                >
                    <option value="all">{i18n("All scopes")}</option>
                    <option value="personal">{i18n("Personal")}</option>
                    <option value="organization">{i18n("Organization")}</option>
                </select>
            </div>

            {loading && !data ? (
                <div className="py-10 text-center text-sm text-muted-foreground">
                    {i18n("Loading profiles…")}
                </div>
            ) : profiles.length === 0 ? (
                <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                    {i18n("No profiles match these filters.")}
                </div>
            ) : (
                <ul className="divide-y rounded-lg border">
                    {profiles.map((profile) => {
                        const channelLabel =
                            profile.channel === "audio"
                                ? i18n("for recordings")
                                : i18n("for mail");
                        const scopeLabel =
                            profile.scope === "personal"
                                ? i18n("Personal")
                                : i18n("Organization");
                        return (
                            <li
                                key={profile.id}
                                className="flex flex-wrap items-center gap-3 px-3 py-2.5"
                            >
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="truncate text-sm font-medium">
                                            {profile.name}
                                        </span>
                                        {profile.isDefault && (
                                            <span className="rounded border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
                                                {i18n("Default")}
                                            </span>
                                        )}
                                        {!profile.canEdit &&
                                            profile.scope ===
                                                "organization" && (
                                                <span className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                                    {i18n("Read-only")}
                                                </span>
                                            )}
                                    </div>
                                    <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                                        {profile.channel === "audio" ? (
                                            <FileAudio
                                                className="size-3"
                                                aria-hidden="true"
                                            />
                                        ) : (
                                            <Mail
                                                className="size-3"
                                                aria-hidden="true"
                                            />
                                        )}
                                        <span>{channelLabel}</span>
                                        <span aria-hidden="true">·</span>
                                        <span>{scopeLabel}</span>
                                    </p>
                                </div>
                                <div className="flex flex-wrap items-center justify-end gap-1">
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        aria-label={
                                            profile.canEdit
                                                ? i18n("Edit {name}", {
                                                      name: profile.name,
                                                  })
                                                : i18n("View {name}", {
                                                      name: profile.name,
                                                  })
                                        }
                                        onClick={() =>
                                            setEditor({
                                                profileId: profile.id,
                                            })
                                        }
                                    >
                                        <Pencil
                                            className="mr-1 size-3.5"
                                            aria-hidden="true"
                                        />
                                        {profile.canEdit
                                            ? i18n("Edit")
                                            : i18n("View")}
                                    </Button>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        aria-label={
                                            profile.scope === "organization"
                                                ? i18n(
                                                      "Duplicate to personal {name}",
                                                      { name: profile.name },
                                                  )
                                                : i18n("Duplicate {name}", {
                                                      name: profile.name,
                                                  })
                                        }
                                        onClick={() =>
                                            void mutate(profile, "duplicate")
                                        }
                                    >
                                        <Copy
                                            className="mr-1 size-3.5"
                                            aria-hidden="true"
                                        />
                                        {profile.scope === "organization"
                                            ? i18n("Duplicate to personal")
                                            : i18n("Duplicate")}
                                    </Button>
                                    {profile.canEdit && !profile.isDefault && (
                                        <>
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="ghost"
                                                aria-label={i18n(
                                                    "Make {name} default",
                                                    { name: profile.name },
                                                )}
                                                onClick={() =>
                                                    void mutate(
                                                        profile,
                                                        "default",
                                                    )
                                                }
                                            >
                                                <Star
                                                    className="mr-1 size-3.5"
                                                    aria-hidden="true"
                                                />
                                                {i18n("Make default")}
                                            </Button>
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="ghost"
                                                aria-label={i18n(
                                                    "Archive {name}",
                                                    { name: profile.name },
                                                )}
                                                onClick={() =>
                                                    void mutate(
                                                        profile,
                                                        "archive",
                                                    )
                                                }
                                            >
                                                <Archive
                                                    className="mr-1 size-3.5"
                                                    aria-hidden="true"
                                                />
                                                {i18n("Archive")}
                                            </Button>
                                        </>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}

            {pagination && pagination.totalPages > 1 && (
                <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
                    <Button
                        type="button"
                        size="icon-sm"
                        variant="outline"
                        aria-label={i18n("Previous page")}
                        disabled={pagination.page <= 1 || loading}
                        onClick={() => setPage((current) => current - 1)}
                    >
                        <ChevronLeft className="size-4" aria-hidden="true" />
                    </Button>
                    <span>
                        {i18n("Page {page, number} of {total, number}", {
                            page: pagination.page,
                            total: pagination.totalPages,
                        })}
                    </span>
                    <Button
                        type="button"
                        size="icon-sm"
                        variant="outline"
                        aria-label={i18n("Next page")}
                        disabled={
                            pagination.page >= pagination.totalPages || loading
                        }
                        onClick={() => setPage((current) => current + 1)}
                    >
                        <ChevronRight className="size-4" aria-hidden="true" />
                    </Button>
                </div>
            )}

            {editor && (
                <ProfileEditor
                    profileId={editor.profileId}
                    newChannel={editor.newChannel}
                    open
                    onOpenChange={closeEditor}
                    onSaved={refreshAfterSave}
                />
            )}
        </div>
    );
}
