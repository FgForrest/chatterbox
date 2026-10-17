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
    RotateCcw,
    Trash2,
} from "lucide-react";
import { useExtracted } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm-dialog";
import { ProfileEditor } from "@/components/settings/profile-editor";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import type { ProfileChannel, ProfileScope } from "@/lib/profiles/settings";
import type {
    SettingsProfileDefault,
    SettingsProfileDefaultOption,
    SettingsProfileSummary,
    SettingsProfilesPage,
} from "@/types/settings";

const PAGE_SIZE = 10;

interface EditorTarget {
    profileId: string | null;
    newChannel?: ProfileChannel;
    newScope?: ProfileScope;
}

const ORGANIZATION_DEFAULT = "organization_default";

interface DefaultProfileSelectProps {
    channel: ProfileChannel;
    state: SettingsProfileDefault;
    options: SettingsProfileDefaultOption[];
    disabled: boolean;
    onChange: (channel: ProfileChannel, value: string) => void;
}

function DefaultProfileSelect({
    channel,
    state,
    options,
    disabled,
    onChange,
}: DefaultProfileSelectProps) {
    const i18n = useExtracted();
    const channelOptions = options.filter(
        (profile) => profile.channel === channel,
    );
    const organizationProfiles = channelOptions.filter(
        (profile) => profile.scope === "organization",
    );
    const personalProfiles = channelOptions.filter(
        (profile) => profile.scope === "personal",
    );
    const label =
        channel === "audio"
            ? i18n("Default for recordings")
            : i18n("Default for mail");
    return (
        <div className="space-y-1.5">
            <label
                className="text-sm font-medium"
                htmlFor={`default-${channel}`}
            >
                {label}
            </label>
            <NativeSelect
                id={`default-${channel}`}
                aria-label={label}
                value={state.selected ?? ""}
                disabled={disabled}
                onChange={(event) => onChange(channel, event.target.value)}
            >
                {!state.selected && (
                    <option value="" disabled>
                        {i18n("Choose a default processing profile")}
                    </option>
                )}
                {state.explicitUnavailable && state.selected && (
                    <option value={state.selected} disabled>
                        {i18n("Unavailable Organization profile")}
                    </option>
                )}
                {state.organizationDefault && (
                    <option value={ORGANIZATION_DEFAULT}>
                        {i18n("Organization default ({name})", {
                            name: state.organizationDefault.name,
                        })}
                    </option>
                )}
                {organizationProfiles.length > 0 && (
                    <optgroup label={i18n("Organization profiles")}>
                        {organizationProfiles.map((profile) => (
                            <option key={profile.id} value={profile.id}>
                                {profile.name}
                            </option>
                        ))}
                    </optgroup>
                )}
                {personalProfiles.length > 0 && (
                    <optgroup label={i18n("Your profiles")}>
                        {personalProfiles.map((profile) => (
                            <option key={profile.id} value={profile.id}>
                                {profile.name}
                            </option>
                        ))}
                    </optgroup>
                )}
            </NativeSelect>
        </div>
    );
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
    const confirm = useConfirm();
    const [search, setSearch] = useState("");
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [channel, setChannel] = useState<"all" | ProfileChannel>("all");
    const [scope, setScope] = useState<
        "all" | "personal" | "organization" | "archived"
    >("all");
    const [newProfileScope, setNewProfileScope] =
        useState<ProfileScope>("personal");
    const [page, setPage] = useState(1);
    const [data, setData] = useState<SettingsProfilesPage | null>(null);
    const [loading, setLoading] = useState(true);
    const [editor, setEditor] = useState<EditorTarget | null>(null);
    const [changingDefault, setChangingDefault] = useState(false);

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
        if (scope === "archived") {
            params.set("archived", "true");
        } else if (scope !== "all") {
            params.set("scope", scope);
        }
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
        action: "duplicate" | "default" | "archive" | "delete" | "restore",
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
        } else if (
            action === "archive" ||
            action === "delete" ||
            action === "restore"
        ) {
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

        let endpoint = `/api/settings/profiles/${encodeURIComponent(profile.id)}`;
        if (action === "duplicate") endpoint = `${endpoint}/duplicate`;
        if (action === "default") endpoint = `${endpoint}/default`;
        if (action === "restore") endpoint = `${endpoint}/restore`;
        try {
            const response = await fetch(endpoint, {
                method:
                    action === "archive" || action === "delete"
                        ? "DELETE"
                        : "POST",
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
            let success = i18n("Profile restored.");
            if (action === "duplicate") success = i18n("Profile duplicated.");
            if (action === "default") {
                success = i18n("Default profile changed.");
            }
            if (action === "archive") success = i18n("Profile archived.");
            if (action === "delete") success = i18n("Profile deleted.");
            toast.success(success);
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

    const changeDefault = async (
        selectedChannel: ProfileChannel,
        value: string,
    ) => {
        setChangingDefault(true);
        try {
            const response = await fetch("/api/settings/profiles/defaults", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    channel: selectedChannel,
                    profileId: value === ORGANIZATION_DEFAULT ? null : value,
                }),
            });
            const body: unknown = await response.json().catch(() => null);
            if (!response.ok) {
                throw new Error(
                    errorMessage(body, i18n("Failed to change the default.")),
                );
            }
            toast.success(i18n("Default profile changed."));
            await loadProfiles();
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Failed to change the default."),
            );
        } finally {
            setChangingDefault(false);
        }
    };

    const removePersonal = (profile: SettingsProfileSummary) => {
        const archives = profile.deleteDisposition === "archive";
        const description = archives
            ? i18n(
                  "This profile will be removed from profile lists. Its processing history will be kept, and you can restore it from Archived.",
              )
            : i18n(
                  "This profile has no processing history and will be permanently deleted.",
              );
        void confirm({
            title: i18n("Delete “{name}”?", { name: profile.name }),
            description,
            confirmLabel: i18n("Delete"),
            pendingLabel: i18n("Deleting…"),
            destructive: true,
            onConfirm: () => mutate(profile, "delete"),
            errorMessage: i18n("Failed to delete profile."),
        });
    };

    const archiveOrganization = (profile: SettingsProfileSummary) => {
        void confirm({
            title: i18n("Archive “{name}”?", { name: profile.name }),
            description: i18n(
                "Archived profiles stop appearing in profile choices. You can restore this profile later.",
            ),
            confirmLabel: i18n("Archive profile"),
            pendingLabel: i18n("Archiving…"),
            destructive: true,
            onConfirm: () => mutate(profile, "archive"),
            errorMessage: i18n("Failed to archive profile."),
        });
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
                        {data?.permissions.canCreateOrganization && (
                            <NativeSelect
                                aria-label={i18n("New profile scope")}
                                className="h-8"
                                value={newProfileScope}
                                onChange={(event) =>
                                    setNewProfileScope(
                                        event.target.value as ProfileScope,
                                    )
                                }
                            >
                                <option value="personal">
                                    {i18n("Personal")}
                                </option>
                                <option value="organization">
                                    {i18n("Organization")}
                                </option>
                            </NativeSelect>
                        )}
                        <Button
                            type="button"
                            size="sm"
                            onClick={() =>
                                setEditor({
                                    profileId: null,
                                    newChannel: "audio",
                                    newScope: newProfileScope,
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
                                    newScope: newProfileScope,
                                })
                            }
                        >
                            <Plus className="mr-1 size-4" aria-hidden="true" />
                            {i18n("New profile for mail")}
                        </Button>
                    </div>
                }
            />

            {data?.defaults && (
                <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
                    <DefaultProfileSelect
                        channel="audio"
                        state={data.defaults.audio}
                        options={data.defaults.options}
                        disabled={changingDefault}
                        onChange={(selectedChannel, value) =>
                            void changeDefault(selectedChannel, value)
                        }
                    />
                    <DefaultProfileSelect
                        channel="mail"
                        state={data.defaults.mail}
                        options={data.defaults.options}
                        disabled={changingDefault}
                        onChange={(selectedChannel, value) =>
                            void changeDefault(selectedChannel, value)
                        }
                    />
                </div>
            )}

            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                <Input
                    type="search"
                    aria-label={i18n("Search profiles")}
                    placeholder={i18n("Search profiles")}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                />
                <NativeSelect
                    aria-label={i18n("Channel")}
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
                </NativeSelect>
                <NativeSelect
                    aria-label={i18n("Scope")}
                    value={scope}
                    onChange={(event) => {
                        setScope(
                            event.target.value as
                                | "all"
                                | "personal"
                                | "organization"
                                | "archived",
                        );
                        setPage(1);
                    }}
                >
                    <option value="all">{i18n("All scopes")}</option>
                    <option value="personal">{i18n("Personal")}</option>
                    <option value="organization">{i18n("Organization")}</option>
                    <option value="archived">{i18n("Archived")}</option>
                </NativeSelect>
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
                                        {profile.isYourDefault && (
                                            <span className="rounded border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
                                                {i18n("Your default")}
                                            </span>
                                        )}
                                        {profile.isOrganizationDefault && (
                                            <span className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                                {i18n("Organization default")}
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
                                    {profile.archivedAt ? (
                                        profile.canEdit && (
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="ghost"
                                                aria-label={i18n(
                                                    "Restore {name}",
                                                    { name: profile.name },
                                                )}
                                                onClick={() =>
                                                    void mutate(
                                                        profile,
                                                        "restore",
                                                    )
                                                }
                                            >
                                                <RotateCcw
                                                    className="mr-1 size-3.5"
                                                    aria-hidden="true"
                                                />
                                                {i18n("Restore")}
                                            </Button>
                                        )
                                    ) : (
                                        <>
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
                                                    profile.scope ===
                                                    "organization"
                                                        ? i18n(
                                                              "Duplicate to personal {name}",
                                                              {
                                                                  name: profile.name,
                                                              },
                                                          )
                                                        : i18n(
                                                              "Duplicate {name}",
                                                              {
                                                                  name: profile.name,
                                                              },
                                                          )
                                                }
                                                onClick={() =>
                                                    void mutate(
                                                        profile,
                                                        "duplicate",
                                                    )
                                                }
                                            >
                                                <Copy
                                                    className="mr-1 size-3.5"
                                                    aria-hidden="true"
                                                />
                                                {profile.scope ===
                                                "organization"
                                                    ? i18n(
                                                          "Duplicate to personal",
                                                      )
                                                    : i18n("Duplicate")}
                                            </Button>
                                            {profile.canEdit &&
                                                profile.scope ===
                                                    "personal" && (
                                                    <Button
                                                        type="button"
                                                        size="sm"
                                                        variant="ghost"
                                                        aria-label={i18n(
                                                            "Delete {name}",
                                                            {
                                                                name: profile.name,
                                                            },
                                                        )}
                                                        onClick={() =>
                                                            removePersonal(
                                                                profile,
                                                            )
                                                        }
                                                    >
                                                        <Trash2
                                                            className="mr-1 size-3.5"
                                                            aria-hidden="true"
                                                        />
                                                        {i18n("Delete")}
                                                    </Button>
                                                )}
                                            {profile.canEdit &&
                                                profile.scope ===
                                                    "organization" &&
                                                !profile.isDefault && (
                                                    <>
                                                        <Button
                                                            type="button"
                                                            size="sm"
                                                            variant="ghost"
                                                            aria-label={i18n(
                                                                "Make {name} Organization default",
                                                                {
                                                                    name: profile.name,
                                                                },
                                                            )}
                                                            onClick={() =>
                                                                void mutate(
                                                                    profile,
                                                                    "default",
                                                                )
                                                            }
                                                        >
                                                            {i18n(
                                                                "Make Organization default",
                                                            )}
                                                        </Button>
                                                        <Button
                                                            type="button"
                                                            size="sm"
                                                            variant="ghost"
                                                            aria-label={i18n(
                                                                "Archive {name}",
                                                                {
                                                                    name: profile.name,
                                                                },
                                                            )}
                                                            onClick={() =>
                                                                archiveOrganization(
                                                                    profile,
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
                    newScope={editor.newScope}
                    open
                    onOpenChange={closeEditor}
                    onSaved={refreshAfterSave}
                />
            )}
        </div>
    );
}
