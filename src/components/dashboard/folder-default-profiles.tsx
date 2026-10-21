"use client";

import { useExtracted } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { accountDefaultUnavailableApplies } from "@/lib/profiles/default-availability";
import type { ProfileChannel, ProfileScope } from "@/lib/profiles/settings";

interface ProfileOption {
    id: string;
    name: string;
    scope: ProfileScope;
}

interface ChannelDefault {
    own: ProfileOption | null;
    ownManualOnly: boolean;
    effective: ProfileOption | null;
    effectiveManualOnly: boolean;
    inheritedFromFolderId: string | null;
    inheritedFromFolderName?: string | null;
    inherited: ProfileOption | null;
    inheritedManualOnly: boolean;
    accountDefault: ProfileOption | null;
    accountDefaultUnavailable: boolean;
}

interface DefaultsResponse {
    scope: "personal" | "org";
    canEdit: boolean;
    defaults: Record<ProfileChannel, ChannelDefault>;
}

const INHERIT_VALUE = "__inherit__";
const MANUAL_ONLY_VALUE = "__manual_only__";

function profileName(
    profile: ProfileOption,
    organizationLabel: string,
): string {
    return profile.scope === "organization"
        ? `${profile.name} · ${organizationLabel}`
        : profile.name;
}

export function FolderDefaultProfiles({
    folderId,
    readOnly = false,
}: {
    folderId: string;
    readOnly?: boolean;
}) {
    const i18n = useExtracted();
    const [failed, setFailed] = useState(false);
    const [defaults, setDefaults] = useState<DefaultsResponse | null>(null);
    const [profiles, setProfiles] = useState<
        Record<ProfileChannel, ProfileOption[]>
    >({ audio: [], mail: [] });
    const [savingChannel, setSavingChannel] = useState<ProfileChannel | null>(
        null,
    );

    const load = useCallback(async () => {
        const [defaultsResponse, audioResponse, mailResponse] =
            await Promise.all([
                fetch(
                    `/api/folders/${encodeURIComponent(folderId)}/default-profiles`,
                ),
                fetch("/api/settings/profiles?channel=audio&pageSize=100"),
                fetch("/api/settings/profiles?channel=mail&pageSize=100"),
            ]);
        if (!defaultsResponse.ok || !audioResponse.ok || !mailResponse.ok) {
            throw new Error("folder default profiles unavailable");
        }
        const [nextDefaults, audio, mail] = (await Promise.all([
            defaultsResponse.json(),
            audioResponse.json(),
            mailResponse.json(),
        ])) as [
            DefaultsResponse,
            { profiles: ProfileOption[] },
            { profiles: ProfileOption[] },
        ];
        setDefaults(nextDefaults);
        setProfiles({ audio: audio.profiles, mail: mail.profiles });
    }, [folderId]);

    useEffect(() => {
        void load().catch(() => setFailed(true));
    }, [load]);

    const save = async (channel: ProfileChannel, value: string) => {
        setSavingChannel(channel);
        try {
            const response = await fetch(
                `/api/folders/${encodeURIComponent(folderId)}/default-profiles`,
                {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        channel,
                        profileId:
                            value === INHERIT_VALUE ||
                            value === MANUAL_ONLY_VALUE
                                ? null
                                : value,
                        ...(value === MANUAL_ONLY_VALUE
                            ? { manualOnly: true }
                            : {}),
                    }),
                },
            );
            if (!response.ok) {
                toast.error(i18n("Could not save the folder profile default."));
                return;
            }
            const body = (await response.json()) as Partial<DefaultsResponse>;
            if (body.defaults && typeof body.canEdit === "boolean") {
                setDefaults(body as DefaultsResponse);
            }
        } catch {
            toast.error(i18n("Could not save the folder profile default."));
        } finally {
            setSavingChannel(null);
        }
    };

    const currentLabel = (channel: ProfileChannel) => {
        const value = defaults?.defaults[channel];
        if (failed) return i18n("Could not load folder profile defaults.");
        if (!value) return i18n("Loading…");
        const accountDefaultUnavailable = accountDefaultUnavailableApplies(
            value.accountDefaultUnavailable,
            value.effectiveManualOnly || value.effective !== null,
        );
        if (value.effectiveManualOnly) {
            return value.inheritedFromFolderId
                ? i18n("{setting} (inherited)", {
                      setting: i18n("Nothing automatic"),
                  })
                : i18n("Nothing automatic");
        }
        if (value.effective) {
            return value.inheritedFromFolderId
                ? i18n("{profile} (inherited)", {
                      profile: profileName(
                          value.effective,
                          i18n("Organization"),
                      ),
                  })
                : profileName(value.effective, i18n("Organization"));
        }
        if (accountDefaultUnavailable) {
            return i18n("Your selected default is unavailable");
        }
        return (
            value.accountDefault?.name ??
            (defaults?.scope === "org"
                ? i18n("Each person's default")
                : i18n("According to settings"))
        );
    };

    const inheritLabel = (channel: ProfileChannel) => {
        const value = defaults?.defaults[channel];
        const accountDefaultUnavailable = accountDefaultUnavailableApplies(
            value?.accountDefaultUnavailable,
            value?.inheritedManualOnly === true || Boolean(value?.inherited),
        );
        if (value?.inheritedManualOnly) {
            return i18n("Inherit ({setting})", {
                setting: i18n("Nothing automatic"),
            });
        }
        if (value?.inherited) {
            return value.inheritedFromFolderName
                ? i18n("Inherit from {folder}: {profile}", {
                      folder: value.inheritedFromFolderName,
                      profile: profileName(
                          value.inherited,
                          i18n("Organization"),
                      ),
                  })
                : i18n("Inherit ({setting})", {
                      setting: profileName(
                          value.inherited,
                          i18n("Organization"),
                      ),
                  });
        }
        if (value?.accountDefault) {
            return i18n("Inherit (your default: {profile})", {
                profile: profileName(
                    value.accountDefault,
                    i18n("Organization"),
                ),
            });
        }
        if (accountDefaultUnavailable) {
            return i18n("Inherit (your selected default is unavailable)");
        }
        if (defaults?.scope === "org") {
            return i18n("Inherit (each person's default)");
        }
        return i18n("Inherit");
    };

    const channelPicker = (channel: ProfileChannel, label: string) => (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!defaults}>
                <span className="min-w-0">
                    <span className="block">{label}</span>
                    <span className="block max-w-64 truncate text-xs text-muted-foreground">
                        {currentLabel(channel)}
                    </span>
                </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-56">
                <DropdownMenuLabel>{label}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                    value={
                        defaults?.defaults[channel].ownManualOnly
                            ? MANUAL_ONLY_VALUE
                            : (defaults?.defaults[channel].own?.id ??
                              INHERIT_VALUE)
                    }
                    onValueChange={(value) => void save(channel, value)}
                >
                    <DropdownMenuRadioItem
                        value={INHERIT_VALUE}
                        disabled={
                            readOnly ||
                            !defaults?.canEdit ||
                            savingChannel === channel
                        }
                    >
                        {inheritLabel(channel)}
                    </DropdownMenuRadioItem>
                    {profiles[channel].map((profile) => (
                        <DropdownMenuRadioItem
                            key={profile.id}
                            value={profile.id}
                            disabled={
                                readOnly ||
                                !defaults?.canEdit ||
                                savingChannel === channel
                            }
                        >
                            {profileName(profile, i18n("Organization"))}
                        </DropdownMenuRadioItem>
                    ))}
                    <DropdownMenuRadioItem
                        value={MANUAL_ONLY_VALUE}
                        disabled={
                            readOnly ||
                            !defaults?.canEdit ||
                            savingChannel === channel
                        }
                    >
                        {i18n("Nothing automatic")}
                    </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                {defaults &&
                    accountDefaultUnavailableApplies(
                        defaults.defaults[channel].accountDefaultUnavailable,
                        defaults.defaults[channel].effectiveManualOnly ||
                            defaults.defaults[channel].effective !== null,
                    ) && (
                        <p className="max-w-72 px-2 py-1.5 text-xs text-muted-foreground">
                            {i18n(
                                "Your selected Organization profile is unavailable. Choose another default in Settings → Profiles.",
                            )}
                        </p>
                    )}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );

    return (
        <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 text-sm">
                <h3 className="font-medium">
                    {i18n("Default processing profile")}
                </h3>
                <p className="text-muted-foreground">
                    {i18n("Recordings")}: {currentLabel("audio")}
                </p>
                <p className="text-muted-foreground">
                    {i18n("Mail")}: {currentLabel("mail")}
                </p>
            </div>
            {!readOnly && defaults?.canEdit && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-9"
                            aria-label={i18n("Change")}
                        >
                            {i18n("Change")}
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-72">
                        {channelPicker(
                            "audio",
                            i18n("Default profile for recordings"),
                        )}
                        {channelPicker(
                            "mail",
                            i18n("Default profile for mail"),
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
        </div>
    );
}
