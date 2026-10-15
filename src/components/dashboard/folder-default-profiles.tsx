"use client";

import { SlidersHorizontal } from "lucide-react";
import { useExtracted } from "next-intl";
import { useCallback, useState } from "react";
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
    inherited: ProfileOption | null;
    inheritedManualOnly: boolean;
    accountDefault: ProfileOption | null;
}

interface DefaultsResponse {
    scope: "personal" | "org";
    canEdit: boolean;
    defaults: Record<ProfileChannel, ChannelDefault>;
}

const INHERIT_VALUE = "__inherit__";
const MANUAL_ONLY_VALUE = "__manual_only__";

export function FolderDefaultProfiles({ folderId }: { folderId: string }) {
    const i18n = useExtracted();
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

    const openChanged = (open: boolean) => {
        if (!open || defaults) return;
        void load().catch(() => {
            toast.error(i18n("Could not load folder profile defaults."));
        });
    };

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
        if (!value) return i18n("None");
        if (value.effectiveManualOnly) {
            return value.inheritedFromFolderId
                ? i18n("{setting} (inherited)", {
                      setting: i18n("Nothing automatic"),
                  })
                : i18n("Nothing automatic");
        }
        if (!value.effective) {
            return (
                value.accountDefault?.name ??
                (defaults?.scope === "org"
                    ? i18n("Each person's default")
                    : i18n("None"))
            );
        }
        return value.inheritedFromFolderId
            ? i18n("{profile} (inherited)", {
                  profile: value.effective.name,
              })
            : value.effective.name;
    };

    const inheritLabel = (channel: ProfileChannel) => {
        const value = defaults?.defaults[channel];
        if (value?.inheritedManualOnly) {
            return i18n("Inherit ({setting})", {
                setting: i18n("Nothing automatic"),
            });
        }
        if (value?.inherited) {
            return i18n("Inherit ({setting})", {
                setting: value.inherited.name,
            });
        }
        if (value?.accountDefault) {
            return i18n("Inherit (your default: {profile})", {
                profile: value.accountDefault.name,
            });
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
                            !defaults?.canEdit || savingChannel === channel
                        }
                    >
                        {inheritLabel(channel)}
                    </DropdownMenuRadioItem>
                    {profiles[channel].map((profile) => (
                        <DropdownMenuRadioItem
                            key={profile.id}
                            value={profile.id}
                            disabled={
                                !defaults?.canEdit || savingChannel === channel
                            }
                        >
                            {profile.name}
                        </DropdownMenuRadioItem>
                    ))}
                    <DropdownMenuRadioItem
                        value={MANUAL_ONLY_VALUE}
                        disabled={
                            !defaults?.canEdit || savingChannel === channel
                        }
                    >
                        {i18n("Nothing automatic")}
                    </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );

    return (
        <DropdownMenu onOpenChange={openChanged}>
            <DropdownMenuTrigger asChild>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9"
                    aria-label={i18n("Default profiles")}
                >
                    <SlidersHorizontal /> {i18n("Default profiles")}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-72">
                {channelPicker("audio", i18n("Default profile for recordings"))}
                {channelPicker("mail", i18n("Default profile for mail"))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
