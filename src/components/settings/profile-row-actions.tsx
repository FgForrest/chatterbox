"use client";

import {
    Archive,
    ChevronDown,
    Copy,
    Eye,
    MoreHorizontal,
    Pencil,
    RotateCcw,
    Star,
    Trash2,
    User,
    Users,
} from "lucide-react";
import { useExtracted } from "next-intl";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ProfileScope } from "@/lib/profiles/settings";
import type { SettingsProfileSummary } from "@/types/settings";

export type ProfileAction =
    | "duplicate"
    | "default"
    | "archive"
    | "delete"
    | "restore"
    | "permanent";

interface Props {
    profile: SettingsProfileSummary;
    canCreateOrganization: boolean;
    canCreatePersonal?: boolean;
    disabled: boolean;
    personalDeleteBlocked?: boolean;
    onEdit: () => void;
    onAction: (action: ProfileAction, scope?: ProfileScope) => void;
}

export function ProfileRowActions({
    profile,
    canCreateOrganization,
    canCreatePersonal = true,
    disabled,
    personalDeleteBlocked = false,
    onEdit,
    onAction,
}: Props) {
    const i18n = useExtracted();
    const archived = Boolean(profile.archivedAt);
    const organization = profile.scope === "organization";
    const organizationDefault =
        profile.isOrganizationDefault || profile.isDefault;
    const archiveReason =
        profile.channel === "audio"
            ? i18n(
                  "The Organization default cannot be archived. First make another profile the default for recordings.",
              )
            : i18n(
                  "The Organization default cannot be archived. First make another profile the default for mail.",
              );
    const deleteReason =
        profile.channel === "audio"
            ? i18n(
                  "Choose another default for recordings before deleting this profile. There is no Organization default to take over.",
              )
            : i18n(
                  "Choose another default for mail before deleting this profile. There is no Organization default to take over.",
              );
    return (
        <div className="flex flex-wrap items-center justify-end gap-1 text-muted-foreground">
            {archived ? (
                profile.canEdit && (
                    <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={disabled}
                        aria-label={i18n("Restore {name}", {
                            name: profile.name,
                        })}
                        onClick={() => onAction("restore")}
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
                                ? i18n("Edit {name}", { name: profile.name })
                                : i18n("View {name}", { name: profile.name })
                        }
                        onClick={onEdit}
                    >
                        {profile.canEdit ? (
                            <Pencil
                                className="mr-1 size-3.5"
                                aria-hidden="true"
                            />
                        ) : (
                            <Eye className="mr-1 size-3.5" aria-hidden="true" />
                        )}
                        {profile.canEdit ? i18n("Edit") : i18n("View")}
                    </Button>
                    {canCreateOrganization ? (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    disabled={disabled}
                                    aria-label={i18n("Duplicate {name}", {
                                        name: profile.name,
                                    })}
                                >
                                    <Copy
                                        className="mr-1 size-3.5"
                                        aria-hidden="true"
                                    />
                                    {i18n("Duplicate")}
                                    <ChevronDown
                                        className="ml-1 size-3"
                                        aria-hidden="true"
                                    />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                                align="end"
                                className="max-w-80"
                            >
                                <DropdownMenuLabel>
                                    {i18n("Where to copy “{name}”", {
                                        name: profile.name,
                                    })}
                                </DropdownMenuLabel>
                                <DropdownMenuItem
                                    onSelect={() =>
                                        onAction("duplicate", "organization")
                                    }
                                >
                                    <Users aria-hidden="true" />
                                    <span>
                                        {i18n("To the Organization")}
                                        <span className="block text-xs text-muted-foreground">
                                            {i18n(
                                                "A new Organization profile with the same settings. It will not be the default.",
                                            )}
                                        </span>
                                    </span>
                                </DropdownMenuItem>
                                {canCreatePersonal && (
                                    <DropdownMenuItem
                                        onSelect={() =>
                                            onAction("duplicate", "personal")
                                        }
                                    >
                                        <User aria-hidden="true" />
                                        <span>
                                            {i18n("To personal profiles")}
                                            <span className="block text-xs text-muted-foreground">
                                                {i18n("Only you will see it.")}
                                            </span>
                                        </span>
                                    </DropdownMenuItem>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ) : (
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={disabled}
                            aria-label={
                                organization
                                    ? i18n("Duplicate to personal {name}", {
                                          name: profile.name,
                                      })
                                    : i18n("Duplicate {name}", {
                                          name: profile.name,
                                      })
                            }
                            onClick={() => onAction("duplicate", "personal")}
                        >
                            <Copy
                                className="mr-1 size-3.5"
                                aria-hidden="true"
                            />
                            {organization
                                ? i18n("Duplicate to personal profiles")
                                : i18n("Duplicate")}
                        </Button>
                    )}
                </>
            )}
            {profile.canEdit && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            disabled={disabled}
                            aria-label={i18n("More actions: {name}", {
                                name: profile.name,
                            })}
                        >
                            <MoreHorizontal
                                className="size-4"
                                aria-hidden="true"
                            />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="max-w-80">
                        {archived || !organization ? (
                            <DropdownMenuItem
                                disabled={personalDeleteBlocked}
                                aria-describedby={
                                    personalDeleteBlocked
                                        ? `delete-reason-${profile.id}`
                                        : undefined
                                }
                                onSelect={() =>
                                    onAction(archived ? "permanent" : "delete")
                                }
                            >
                                <Trash2 aria-hidden="true" />
                                <span>
                                    {archived
                                        ? i18n("Delete permanently…")
                                        : i18n("Delete…")}
                                    {archived && (
                                        <span className="block text-xs text-muted-foreground">
                                            {i18n(
                                                "Archived profiles only. Cannot be undone.",
                                            )}
                                        </span>
                                    )}
                                </span>
                            </DropdownMenuItem>
                        ) : (
                            <>
                                {!organizationDefault && (
                                    <>
                                        <DropdownMenuItem
                                            onSelect={() => onAction("default")}
                                        >
                                            <Star aria-hidden="true" />
                                            {i18n("Make Organization default")}
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator />
                                    </>
                                )}
                                <DropdownMenuItem
                                    disabled={organizationDefault}
                                    aria-describedby={
                                        organizationDefault
                                            ? `archive-reason-${profile.id}`
                                            : undefined
                                    }
                                    onSelect={() => onAction("archive")}
                                >
                                    <Archive aria-hidden="true" />
                                    <span>
                                        {i18n("Archive…")}
                                        <span className="block text-xs text-muted-foreground">
                                            {i18n(
                                                "Disappears from profile choices. Can be restored.",
                                            )}
                                        </span>
                                    </span>
                                </DropdownMenuItem>
                                {organizationDefault && (
                                    <p
                                        id={`archive-reason-${profile.id}`}
                                        className="px-2 pb-2 text-xs text-muted-foreground"
                                    >
                                        {archiveReason}
                                    </p>
                                )}
                            </>
                        )}
                        {personalDeleteBlocked && (
                            <p
                                id={`delete-reason-${profile.id}`}
                                className="px-2 pb-2 text-xs text-muted-foreground"
                            >
                                {deleteReason}
                            </p>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
        </div>
    );
}
