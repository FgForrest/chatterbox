"use client";

import {
    Archive,
    ChevronLeft,
    ChevronRight,
    FileAudio,
    Lock,
    Mail,
    Plus,
    User,
    Users,
} from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm-dialog";
import { ProfileEditor } from "@/components/settings/profile-editor";
import {
    type ProfileAction,
    ProfileRowActions,
} from "@/components/settings/profile-row-actions";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { Button } from "@/components/ui/button";
import { HeadingCount } from "@/components/ui/heading-count";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import type { ProfileChannel, ProfileScope } from "@/lib/profiles/settings";
import type {
    SettingsProfileDefault,
    SettingsProfileDefaultOption,
    SettingsProfileSection,
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
                className="block text-sm font-medium"
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
    const locale = useLocale();
    const confirm = useConfirm();
    const [search, setSearch] = useState("");
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [channel, setChannel] = useState<"all" | ProfileChannel>("all");
    const [pages, setPages] = useState({
        organization: 1,
        personal: 1,
        archived: 1,
    });
    const [archivedOpen, setArchivedOpen] = useState(true);
    const [mutating, setMutating] = useState(false);
    const requestId = useRef(0);
    const [newProfileScope, setNewProfileScope] =
        useState<ProfileScope>("personal");
    const [data, setData] = useState<SettingsProfilesPage | null>(null);
    const [loading, setLoading] = useState(true);
    const [editor, setEditor] = useState<EditorTarget | null>(null);
    const [changingDefault, setChangingDefault] = useState(false);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setDebouncedSearch(search.trim());
            setPages({ organization: 1, personal: 1, archived: 1 });
        }, 250);
        return () => window.clearTimeout(timer);
    }, [search]);

    const query = useMemo(() => {
        const params = new URLSearchParams();
        if (debouncedSearch) params.set("q", debouncedSearch);
        if (channel !== "all") params.set("channel", channel);
        params.set("sectioned", "true");
        params.set("organizationPage", String(pages.organization));
        params.set("personalPage", String(pages.personal));
        params.set("archivedPage", String(pages.archived));
        params.set("pageSize", String(PAGE_SIZE));
        return params.toString();
    }, [channel, debouncedSearch, pages]);

    const latestQuery = useRef(query);
    latestQuery.current = query;

    const loadProfiles = useCallback(async () => {
        if (latestQuery.current !== query) return;
        const currentRequest = ++requestId.current;
        setLoading(true);
        try {
            const response = await fetch(`/api/settings/profiles?${query}`);
            if (!response.ok) throw new Error("load");
            const body = (await response.json()) as SettingsProfilesPage;
            if (currentRequest === requestId.current) {
                setData(body);
                if (body.sections) {
                    const normalized = {
                        organization:
                            body.sections.organization.pagination.page,
                        personal: body.sections.personal.pagination.page,
                        archived: body.sections.archived.pagination.page,
                    };
                    setPages((current) =>
                        current.organization === normalized.organization &&
                        current.personal === normalized.personal &&
                        current.archived === normalized.archived
                            ? current
                            : normalized,
                    );
                }
            }
        } catch {
            if (currentRequest === requestId.current)
                toast.error(i18n("Failed to load profiles."));
        } finally {
            if (currentRequest === requestId.current) setLoading(false);
        }
    }, [i18n, query]);

    useEffect(() => {
        void loadProfiles();
        return () => {
            requestId.current++;
        };
    }, [loadProfiles]);

    const mutate = async (
        profile: SettingsProfileSummary,
        action: ProfileAction,
        destination?: ProfileScope,
    ) => {
        const previous = data;
        setMutating(true);
        if (action === "default") {
            setData((current) =>
                current?.sections
                    ? {
                          ...current,
                          sections: {
                              ...current.sections,
                              organization: {
                                  ...current.sections.organization,
                                  profiles:
                                      current.sections.organization.profiles.map(
                                          (item) =>
                                              item.channel === profile.channel
                                                  ? {
                                                        ...item,
                                                        isDefault:
                                                            item.id ===
                                                            profile.id,
                                                        isOrganizationDefault:
                                                            item.id ===
                                                            profile.id,
                                                    }
                                                  : item,
                                      ),
                              },
                          },
                      }
                    : current,
            );
        } else if (
            ["archive", "delete", "permanent", "restore"].includes(action)
        ) {
            setData((current) => {
                if (!current?.sections) return current;
                const section = profile.archivedAt ? "archived" : profile.scope;
                const sectionData = current.sections[section];
                return {
                    ...current,
                    sections: {
                        ...current.sections,
                        [section]: {
                            ...sectionData,
                            profiles: sectionData.profiles.filter(
                                (item) => item.id !== profile.id,
                            ),
                            pagination: {
                                ...sectionData.pagination,
                                total: Math.max(
                                    0,
                                    sectionData.pagination.total - 1,
                                ),
                            },
                        },
                    },
                };
            });
        }
        let endpoint = `/api/settings/profiles/${encodeURIComponent(profile.id)}`;
        if (["duplicate", "default", "restore", "permanent"].includes(action))
            endpoint += `/${action}`;
        try {
            const response = await fetch(endpoint, {
                method: ["archive", "delete", "permanent"].includes(action)
                    ? "DELETE"
                    : "POST",
                ...(action === "duplicate"
                    ? {
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                              scope: destination ?? "personal",
                          }),
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
            if (action === "duplicate") {
                const copy = (await response.json()) as {
                    profile: SettingsProfileSummary;
                };
                success =
                    destination === "organization"
                        ? i18n("Copied to the Organization as “{name}”.", {
                              name: copy.profile.name,
                          })
                        : i18n("Copied to personal profiles as “{name}”.", {
                              name: copy.profile.name,
                          });
            }
            if (action === "default")
                success = i18n("Default profile changed.");
            if (action === "archive") success = i18n("Profile archived.");
            if (action === "delete" || action === "permanent")
                success = i18n("Profile deleted.");
            toast.success(success);
            await loadProfiles();
        } catch (error) {
            if (previous && latestQuery.current === query) setData(previous);
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Failed to update profile."),
            );
        } finally {
            setMutating(false);
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

    const deleteImpact = async (
        profile: SettingsProfileSummary,
    ): Promise<{ memberDefaultCount: number }> => {
        const response = await fetch(
            `/api/settings/profiles/${encodeURIComponent(profile.id)}?deleteImpact=true`,
        );
        if (!response.ok)
            throw new Error(i18n("Failed to load delete impact."));
        const body = (await response.json()) as {
            deleteImpact?: { memberDefaultCount: number };
        };
        if (!body.deleteImpact) {
            throw new Error(i18n("Failed to load delete impact."));
        }
        return body.deleteImpact;
    };

    const removeProfile = (
        profile: SettingsProfileSummary,
        action: "delete" | "permanent",
    ) => {
        void confirm({
            title: i18n("Delete profile “{name}” permanently?", {
                name: profile.name,
            }),
            description: i18n(
                "The profile disappears and cannot be restored. Recordings, summaries and tasks made with it stay.",
            ),
            confirmLabel: i18n("Delete permanently"),
            pendingLabel: i18n("Deleting…"),
            destructive: true,
            onConfirm: () => mutate(profile, action),
            errorMessage: i18n("Failed to delete profile."),
        });
    };

    const archiveOrganization = async (profile: SettingsProfileSummary) => {
        let impact: { memberDefaultCount: number };
        try {
            impact = await deleteImpact(profile);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Failed to load delete impact."),
            );
            return;
        }
        const memberDefaultCount = impact.memberDefaultCount;
        void confirm({
            title: i18n("Archive “{name}”?", { name: profile.name }),
            description: i18n(
                "Archived profiles stop appearing in profile choices. You can restore this profile later. Members using this profile as their default: {count, number}. Their processing will stop with an error until they choose another default.",
                { count: memberDefaultCount },
            ),
            confirmLabel: i18n("Archive profile"),
            pendingLabel: i18n("Archiving…"),
            destructive: true,
            onConfirm: () => mutate(profile, "archive"),
            errorMessage: i18n("Failed to archive profile."),
        });
    };

    const closeEditor = useCallback((open: boolean) => {
        if (!open) setEditor(null);
    }, []);
    const refreshAfterSave = useCallback(() => {
        void loadProfiles();
    }, [loadProfiles]);
    const filtered = debouncedSearch !== "" || channel !== "all";
    const noProfilesYet = {
        organization: i18n("No Organization profiles yet."),
        personal: i18n("No personal profiles yet."),
    };

    return (
        <div className="space-y-5">
            <SettingsSectionHeader
                className="flex-wrap [&>div:first-child]:basis-60 [&>div:last-child]:min-w-0 [&>div:last-child]:max-w-full"
                title={i18n("Profiles")}
                description={i18n(
                    "Choose how recordings and mail are transcribed, learned from, titled, summarized, and turned into tasks.",
                )}
                icon={FileAudio}
                action={
                    <div className="flex flex-wrap justify-end gap-2">
                        {data?.permissions.canCreateOrganization &&
                            data.permissions.canCreatePersonal !== false && (
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
                                    newScope:
                                        data?.permissions.canCreatePersonal ===
                                        false
                                            ? "organization"
                                            : newProfileScope,
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
                                    newScope:
                                        data?.permissions.canCreatePersonal ===
                                        false
                                            ? "organization"
                                            : newProfileScope,
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
                        disabled={changingDefault || mutating}
                        onChange={(selectedChannel, value) =>
                            void changeDefault(selectedChannel, value)
                        }
                    />
                    <DefaultProfileSelect
                        channel="mail"
                        state={data.defaults.mail}
                        options={data.defaults.options}
                        disabled={changingDefault || mutating}
                        onChange={(selectedChannel, value) =>
                            void changeDefault(selectedChannel, value)
                        }
                    />
                </div>
            )}

            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
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
                        setPages({ organization: 1, personal: 1, archived: 1 });
                    }}
                >
                    <option value="all">{i18n("All channels")}</option>
                    <option value="audio">{i18n("For recordings")}</option>
                    <option value="mail">{i18n("For mail")}</option>
                </NativeSelect>
            </div>

            {loading && !data ? (
                <div className="py-10 text-center text-sm text-muted-foreground">
                    {i18n("Loading profiles…")}
                </div>
            ) : (
                (["organization", "personal", "archived"] as const).map(
                    (section: SettingsProfileSection) => {
                        const group = data?.sections?.[section];
                        if (
                            !group ||
                            (section === "archived" &&
                                group.pagination.total === 0 &&
                                !filtered)
                        )
                            return null;
                        const label =
                            section === "organization"
                                ? i18n("Organization")
                                : section === "personal"
                                  ? i18n("Personal")
                                  : i18n("Archived");
                        const Icon =
                            section === "organization"
                                ? Users
                                : section === "personal"
                                  ? User
                                  : Archive;
                        const pagination = group.pagination;
                        return (
                            <section
                                key={section}
                                aria-labelledby={`profiles-${section}`}
                                className="space-y-2"
                            >
                                <div className="flex flex-wrap items-center gap-2">
                                    <h3
                                        id={`profiles-${section}`}
                                        className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide"
                                    >
                                        <Icon
                                            className={
                                                section === "organization"
                                                    ? "size-3.5 text-organization"
                                                    : "size-3.5 text-muted-foreground"
                                            }
                                            aria-hidden="true"
                                        />
                                        {label}
                                    </h3>
                                    <HeadingCount>
                                        {pagination.total}
                                    </HeadingCount>
                                    {section === "organization" && (
                                        <p className="text-xs text-muted-foreground">
                                            {i18n(
                                                "Applies to members who have not chosen their own default profile.",
                                            )}
                                        </p>
                                    )}
                                    {section === "archived" && (
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="ghost"
                                            className={
                                                archivedOpen
                                                    ? "ml-auto bg-accent"
                                                    : "ml-auto"
                                            }
                                            aria-pressed={archivedOpen}
                                            aria-expanded={archivedOpen}
                                            aria-controls="archived-profiles"
                                            onClick={() =>
                                                setArchivedOpen((open) => !open)
                                            }
                                        >
                                            {archivedOpen
                                                ? i18n("Hide")
                                                : i18n("Show")}
                                        </Button>
                                    )}
                                </div>
                                {(section !== "archived" || archivedOpen) && (
                                    <div
                                        id={
                                            section === "archived"
                                                ? "archived-profiles"
                                                : undefined
                                        }
                                        className="space-y-2"
                                    >
                                        {group.profiles.length === 0 ? (
                                            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                                                {filtered ||
                                                section === "archived"
                                                    ? i18n(
                                                          "No profiles match these filters.",
                                                      )
                                                    : noProfilesYet[section]}
                                            </p>
                                        ) : (
                                            <ul className="divide-y rounded-lg border">
                                                {group.profiles.map(
                                                    (profile) => (
                                                        <li
                                                            key={profile.id}
                                                            className={`@container flex flex-wrap items-center gap-3 px-3 py-2.5 ${profile.archivedAt ? "bg-muted/60" : ""}`}
                                                        >
                                                            <div className="min-w-0 flex-1 basis-full @min-[560px]:basis-64">
                                                                <div className="flex flex-wrap items-center gap-2">
                                                                    <span
                                                                        className={`min-w-0 truncate text-sm font-medium ${profile.archivedAt ? "text-muted-foreground" : ""}`}
                                                                    >
                                                                        {
                                                                            profile.name
                                                                        }
                                                                    </span>
                                                                    {profile.isYourDefault && (
                                                                        <span className="whitespace-nowrap rounded border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
                                                                            {i18n(
                                                                                "Your default",
                                                                            )}
                                                                        </span>
                                                                    )}
                                                                    {profile.isOrganizationDefault && (
                                                                        <span className="whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                                                            {i18n(
                                                                                "Organization default",
                                                                            )}
                                                                        </span>
                                                                    )}
                                                                    {!profile.canEdit &&
                                                                        profile.scope ===
                                                                            "organization" && (
                                                                            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                                                                <Lock
                                                                                    className="size-3"
                                                                                    aria-hidden="true"
                                                                                />
                                                                                {i18n(
                                                                                    "Read-only",
                                                                                )}
                                                                            </span>
                                                                        )}
                                                                </div>
                                                                <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                                                                    {profile.channel ===
                                                                    "audio" ? (
                                                                        <FileAudio
                                                                            className="size-3 shrink-0"
                                                                            aria-hidden="true"
                                                                        />
                                                                    ) : (
                                                                        <Mail
                                                                            className="size-3 shrink-0"
                                                                            aria-hidden="true"
                                                                        />
                                                                    )}
                                                                    <span>
                                                                        {profile.channel ===
                                                                        "audio"
                                                                            ? i18n(
                                                                                  "for recordings",
                                                                              )
                                                                            : i18n(
                                                                                  "for mail",
                                                                              )}
                                                                    </span>
                                                                    <span aria-hidden="true">
                                                                        ·
                                                                    </span>
                                                                    <span className="inline-flex items-center gap-1">
                                                                        {profile.scope ===
                                                                            "organization" && (
                                                                            <Users
                                                                                className="size-3 shrink-0"
                                                                                aria-hidden="true"
                                                                            />
                                                                        )}
                                                                        {profile.scope ===
                                                                        "organization"
                                                                            ? i18n(
                                                                                  "Organization",
                                                                              )
                                                                            : i18n(
                                                                                  "Personal",
                                                                              )}
                                                                    </span>
                                                                    {profile.archivedAt && (
                                                                        <>
                                                                            <span aria-hidden="true">
                                                                                ·
                                                                            </span>
                                                                            <time
                                                                                dateTime={
                                                                                    profile.archivedAt
                                                                                }
                                                                            >
                                                                                {i18n(
                                                                                    "Archived {date}",
                                                                                    {
                                                                                        date: new Date(
                                                                                            profile.archivedAt,
                                                                                        ).toLocaleDateString(
                                                                                            locale,
                                                                                            {
                                                                                                dateStyle:
                                                                                                    "medium",
                                                                                            },
                                                                                        ),
                                                                                    },
                                                                                )}
                                                                            </time>
                                                                        </>
                                                                    )}
                                                                </p>
                                                            </div>
                                                            <ProfileRowActions
                                                                personalDeleteBlocked={
                                                                    profile.scope ===
                                                                        "personal" &&
                                                                    Boolean(
                                                                        profile.isYourDefault,
                                                                    ) &&
                                                                    !data
                                                                        ?.defaults?.[
                                                                        profile
                                                                            .channel
                                                                    ]
                                                                        .organizationDefault
                                                                }
                                                                profile={
                                                                    profile
                                                                }
                                                                canCreateOrganization={
                                                                    data
                                                                        ?.permissions
                                                                        .canCreateOrganization ??
                                                                    false
                                                                }
                                                                canCreatePersonal={
                                                                    data
                                                                        ?.permissions
                                                                        .canCreatePersonal !==
                                                                    false
                                                                }
                                                                disabled={
                                                                    mutating ||
                                                                    changingDefault
                                                                }
                                                                onEdit={() =>
                                                                    setEditor({
                                                                        profileId:
                                                                            profile.id,
                                                                    })
                                                                }
                                                                onAction={(
                                                                    action,
                                                                    scope,
                                                                ) => {
                                                                    if (
                                                                        action ===
                                                                            "delete" ||
                                                                        action ===
                                                                            "permanent"
                                                                    )
                                                                        removeProfile(
                                                                            profile,
                                                                            action,
                                                                        );
                                                                    else if (
                                                                        action ===
                                                                        "archive"
                                                                    )
                                                                        void archiveOrganization(
                                                                            profile,
                                                                        );
                                                                    else
                                                                        void mutate(
                                                                            profile,
                                                                            action,
                                                                            scope,
                                                                        );
                                                                }}
                                                            />
                                                        </li>
                                                    ),
                                                )}
                                            </ul>
                                        )}
                                        {pagination.totalPages > 1 && (
                                            <nav
                                                aria-label={i18n(
                                                    "{section} profile pages",
                                                    { section: label },
                                                )}
                                                className="flex items-center justify-end gap-2 text-sm text-muted-foreground"
                                            >
                                                <Button
                                                    type="button"
                                                    size="icon-sm"
                                                    variant="outline"
                                                    aria-label={i18n(
                                                        "Previous page",
                                                    )}
                                                    disabled={
                                                        pagination.page <= 1 ||
                                                        loading ||
                                                        mutating
                                                    }
                                                    onClick={() =>
                                                        setPages((current) => ({
                                                            ...current,
                                                            [section]:
                                                                pagination.page -
                                                                1,
                                                        }))
                                                    }
                                                >
                                                    <ChevronLeft
                                                        className="size-4"
                                                        aria-hidden="true"
                                                    />
                                                </Button>
                                                <span>
                                                    {i18n(
                                                        "Page {page, number} of {total, number}",
                                                        {
                                                            page: pagination.page,
                                                            total: pagination.totalPages,
                                                        },
                                                    )}
                                                </span>
                                                <Button
                                                    type="button"
                                                    size="icon-sm"
                                                    variant="outline"
                                                    aria-label={i18n(
                                                        "Next page",
                                                    )}
                                                    disabled={
                                                        pagination.page >=
                                                            pagination.totalPages ||
                                                        loading ||
                                                        mutating
                                                    }
                                                    onClick={() =>
                                                        setPages((current) => ({
                                                            ...current,
                                                            [section]:
                                                                pagination.page +
                                                                1,
                                                        }))
                                                    }
                                                >
                                                    <ChevronRight
                                                        className="size-4"
                                                        aria-hidden="true"
                                                    />
                                                </Button>
                                            </nav>
                                        )}
                                    </div>
                                )}
                            </section>
                        );
                    },
                )
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
