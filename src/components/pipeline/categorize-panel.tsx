"use client";

import { GraduationCap, Loader2 } from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { CreatedFolder } from "@/components/pipeline/new-folder-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { getApiErrorMessage } from "@/lib/api-errors";
import type {
    CategorizationPanelPresentation,
    ProcessingFolderSummary,
    ProcessingResolution,
} from "@/lib/pipeline/categorization-presentation";
import { accountDefaultUnavailableApplies } from "@/lib/profiles/default-availability";

export type CategorizePanelData = CategorizationPanelPresentation;

export interface CategorizeSubmission {
    folderIds: string[];
    profileId?: string;
    manualOnly?: boolean;
}

export interface ProfileAutomationDetails {
    description: string | null;
    automatic: {
        transcribe: boolean;
        learn: boolean;
        summary: boolean;
        title: boolean;
        topics: boolean;
    };
}

interface CategorizePanelProps {
    data: CategorizePanelData;
    kind: "audio" | "mail";
    mode: "folder" | "profile";
    reason?: "needs_profile" | "profile_unavailable";
    profileDetails?: Partial<Record<string, ProfileAutomationDetails>>;
    onFolderCreated?: (folder: CreatedFolder) => void;
    onCategorized?: (folderIds: string[]) => void;
    onOptimisticCategorize?: (submission: CategorizeSubmission) => () => void;
    onTranscribe?: () => void;
}

const MANUAL_ONLY = "__manual_only__";
const NEW_FOLDER = "__new_folder__";
const ORGANIZATION_DEFAULT = "__organization_default__";
const UNAVAILABLE_DEFAULT = "__unavailable_default__";

function resolutionChoice(resolution: ProcessingResolution): string {
    if (resolution.status !== "resolved") return "";
    return resolution.manualOnly ? MANUAL_ONLY : resolution.profile.id;
}

function unresolvedAccountDefault(data: CategorizePanelData): boolean {
    const higherPrecedenceResolved =
        data.currentProfile !== null ||
        (data.resolution.status === "resolved" &&
            data.resolution.source === "folder");
    return accountDefaultUnavailableApplies(
        data.defaultProfileUnavailable,
        higherPrecedenceResolved,
    );
}

function initialProfileChoice(data: CategorizePanelData): string {
    if (data.currentProfile) {
        return data.currentManualOnly ? MANUAL_ONLY : data.currentProfile.id;
    }
    if (unresolvedAccountDefault(data)) return UNAVAILABLE_DEFAULT;
    if (
        data.followsOrganizationDefault &&
        data.organizationDefault &&
        data.resolution.status === "resolved" &&
        data.resolution.source === "default" &&
        data.resolution.profile.id === data.organizationDefault.id
    ) {
        return ORGANIZATION_DEFAULT;
    }
    return resolutionChoice(data.resolution);
}

function automaticFromProfileResponse(
    value: unknown,
): ProfileAutomationDetails | null {
    if (!value || typeof value !== "object") return null;
    const response = value as {
        profile?: {
            description?: unknown;
            settings?: {
                steps?: Record<string, { automatic?: unknown } | undefined>;
            };
        };
    };
    const profile = response.profile;
    const steps = profile?.settings?.steps;
    if (!profile || !steps) return null;
    const automatic = (step: string) => steps[step]?.automatic === true;
    return {
        description:
            typeof profile.description === "string"
                ? profile.description
                : null,
        automatic: {
            transcribe: automatic("transcribe"),
            learn: automatic("learn"),
            summary: automatic("summary"),
            title: automatic("title"),
            topics: automatic("topics"),
        },
    };
}

/** Inline folder and profile choice shown at the Categorize workflow step. */
export function CategorizePanel({
    data,
    kind,
    mode,
    reason,
    profileDetails,
    onFolderCreated,
    onCategorized,
    onOptimisticCategorize,
    onTranscribe,
}: CategorizePanelProps) {
    const i18n = useExtracted();
    const locale = useLocale();
    const profileTrigger = useRef<HTMLButtonElement>(null);
    const [folders, setFolders] = useState(data.folders);
    const fileableFolders = folders.filter(
        (folder) => folder.parentId !== null,
    );
    const [folderId, setFolderId] = useState(data.selectedFolderIds[0] ?? "");
    const [profileChoice, setProfileChoice] = useState(
        initialProfileChoice(data),
    );
    const [details, setDetails] = useState(profileDetails ?? {});
    const [previewing, setPreviewing] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [creating, setCreating] = useState(false);
    const [newFolderOpen, setNewFolderOpen] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");
    const defaultProfileUnavailable = unresolvedAccountDefault(data);
    const roots = folders.filter(
        (folder) =>
            folder.parentId === null &&
            (folder.scope === "personal" || data.canCreateOrganizationFolders),
    );
    const [newFolderRootId, setNewFolderRootId] = useState(
        roots.find((root) => root.scope === "personal")?.id ??
            roots[0]?.id ??
            "",
    );

    useEffect(() => {
        if (mode === "profile") profileTrigger.current?.focus();
    }, [mode]);

    useEffect(() => {
        const detailProfileId =
            profileChoice === ORGANIZATION_DEFAULT
                ? data.organizationDefault?.id
                : profileChoice;
        if (
            profileChoice === MANUAL_ONLY ||
            profileChoice === UNAVAILABLE_DEFAULT ||
            !detailProfileId ||
            details[detailProfileId]
        ) {
            return;
        }
        const controller = new AbortController();
        void fetch(
            `/api/settings/profiles/${encodeURIComponent(detailProfileId)}`,
            { signal: controller.signal },
        )
            .then(async (response) => {
                if (!response.ok) return null;
                return automaticFromProfileResponse(await response.json());
            })
            .then((detail) => {
                if (detail) {
                    setDetails((current) => ({
                        ...current,
                        [detailProfileId]: detail,
                    }));
                }
            })
            .catch(() => {});
        return () => controller.abort();
    }, [data.organizationDefault?.id, details, profileChoice]);

    const profileOptions = useMemo(() => {
        const byId = new Map(
            data.profiles.map((profile) => [profile.id, profile]),
        );
        if (data.currentProfile) {
            byId.set(data.currentProfile.id, data.currentProfile);
        }
        if (data.resolution.status === "choose") {
            for (const candidate of data.resolution.candidates) {
                if (candidate.kind === "profile") {
                    byId.set(candidate.profile.id, candidate.profile);
                }
            }
        } else if (data.resolution.status === "resolved") {
            byId.set(data.resolution.profile.id, data.resolution.profile);
        }
        return [...byId.values()];
    }, [data]);
    const selectedFolder = folders.find((folder) => folder.id === folderId);
    let selectedProfileId: string | undefined = profileChoice;
    if (profileChoice === ORGANIZATION_DEFAULT) {
        selectedProfileId = data.organizationDefault?.id;
    }
    if (profileChoice === UNAVAILABLE_DEFAULT) selectedProfileId = undefined;
    const selectedProfile = profileOptions.find(
        (profile) => profile.id === selectedProfileId,
    );
    const selectedDetails =
        profileChoice === MANUAL_ONLY || !selectedProfileId
            ? null
            : details[selectedProfileId];
    const prefilledChoice = initialProfileChoice(data);

    const selectFolder = async (nextFolderId: string) => {
        if (nextFolderId === NEW_FOLDER) {
            setNewFolderOpen(true);
            return;
        }
        setFolderId(nextFolderId);
        if (mode === "profile") return;
        setPreviewing(true);
        try {
            const response = await fetch(
                `/api/recordings/${encodeURIComponent(data.itemId)}/categorize/preview`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ folderIds: [nextFolderId] }),
                },
            );
            if (!response.ok) throw new Error(String(response.status));
            const body = (await response.json()) as {
                resolution: ProcessingResolution;
            };
            setProfileChoice(resolutionChoice(body.resolution));
        } catch {
            toast.error(i18n("The profile preview could not be loaded."));
        } finally {
            setPreviewing(false);
        }
    };

    const createFolder = async () => {
        const name = newFolderName.trim();
        if (!name || !newFolderRootId) return;
        setCreating(true);
        try {
            const response = await fetch("/api/folders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ parentId: newFolderRootId, name }),
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("The folder could not be created."),
                    ),
                );
                return;
            }
            const { folder } = (await response.json()) as {
                folder: CreatedFolder;
            };
            const root = roots.find(
                (candidate) => candidate.id === folder.parentId,
            );
            const presented: ProcessingFolderSummary = {
                id: folder.id,
                parentId: folder.parentId,
                name: folder.name,
                path: root ? `${root.path} › ${folder.name}` : folder.name,
                scope: folder.scope === "org" ? "org" : "personal",
            };
            setFolders((current) => [...current, presented]);
            await selectFolder(folder.id);
            setNewFolderOpen(false);
            setNewFolderName("");
            onFolderCreated?.(folder);
            toast.success(i18n("Folder created."));
        } catch {
            toast.error(i18n("The folder could not be created."));
        } finally {
            setCreating(false);
        }
    };

    const submit = async () => {
        if (!folderId || !profileChoice || previewing || submitting) return;
        const folderIds =
            mode === "profile" && data.selectedFolderIds.length > 0
                ? data.selectedFolderIds
                : [folderId];
        const submission: CategorizeSubmission = { folderIds };
        if (
            profileChoice === MANUAL_ONLY &&
            profileChoice !== prefilledChoice
        ) {
            submission.manualOnly = true;
        } else if (profileChoice !== prefilledChoice) {
            if (profileChoice === ORGANIZATION_DEFAULT) {
                submission.profileId = data.organizationDefault?.id;
            } else {
                submission.profileId = profileChoice;
            }
        }
        const rollback = onOptimisticCategorize?.(submission);
        setSubmitting(true);
        try {
            const response = await fetch(
                `/api/recordings/${encodeURIComponent(data.itemId)}/categorize`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(submission),
                },
            );
            if (!response.ok) {
                rollback?.();
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("The item could not be filed."),
                    ),
                );
                return;
            }
            onCategorized?.(folderIds);
            toast.success(i18n("Item filed."));
        } catch {
            rollback?.();
            toast.error(i18n("The item could not be filed."));
        } finally {
            setSubmitting(false);
        }
    };

    const automaticLabels = selectedDetails
        ? [
              kind === "audio" && selectedDetails.automatic.transcribe
                  ? i18n("transcription")
                  : null,
              selectedDetails.automatic.learn ? i18n("Learn") : null,
              selectedDetails.automatic.summary ? i18n("summary") : null,
              selectedDetails.automatic.title ? i18n("title") : null,
              selectedDetails.automatic.topics ? i18n("topics") : null,
          ].filter((label): label is string => label !== null)
        : [];
    const automaticList = new Intl.ListFormat(locale, {
        style: "long",
        type: "conjunction",
    }).format(automaticLabels);
    const nothingAutomatic = i18n(
        "Nothing runs automatically. You start each step yourself.",
    );
    let automationSentence: string | null = null;
    if (!profileChoice) {
        automationSentence = null;
    } else if (profileChoice === MANUAL_ONLY) {
        automationSentence = nothingAutomatic;
    } else if (!selectedDetails) {
        automationSentence = i18n("Loading profile automation…");
    } else if (automaticLabels.length === 0) {
        automationSentence = nothingAutomatic;
    } else {
        automationSentence = i18n(
            "After categorizing, these run by themselves: {steps}.",
            { steps: automaticList },
        );
    }
    let folderHint: string;
    if (selectedFolder?.scope !== "org") {
        folderHint = i18n("Learn will use this folder as context.");
    } else if (profileChoice === MANUAL_ONLY) {
        folderHint = i18n("The item is shared when you say so.");
    } else {
        folderHint = i18n("The item is shared after the review.");
    }

    return (
        <section
            className="overflow-hidden rounded-lg border bg-card"
            aria-labelledby="categorize-title"
        >
            <header className="border-b px-4 py-4 sm:px-5">
                <h2 id="categorize-title" className="text-base font-medium">
                    {kind === "mail"
                        ? i18n("Categorize email")
                        : i18n("Categorize recording")}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    {i18n(
                        "Choose its folder and an existing profile in one step.",
                    )}
                </p>
                {mode === "profile" && (
                    <p className="mt-2 text-sm text-[var(--step-review)]">
                        {reason === "profile_unavailable"
                            ? i18n(
                                  "The assigned profile is no longer available. Choose another one.",
                              )
                            : i18n(
                                  "These folders suggest different profiles. Choose one to continue.",
                              )}
                    </p>
                )}
            </header>

            <div className="space-y-4 px-4 py-4 sm:px-5">
                <div className="grid gap-4 sm:grid-cols-2 sm:gap-6">
                    <fieldset className="min-w-0 space-y-1.5 rounded-md border p-3">
                        <legend className="px-1 text-sm font-medium">
                            {i18n("Folder")}
                        </legend>
                        {newFolderOpen ? (
                            <div className="space-y-2">
                                <Input
                                    aria-label={i18n("Folder name")}
                                    value={newFolderName}
                                    onChange={(event) =>
                                        setNewFolderName(event.target.value)
                                    }
                                    autoFocus
                                />
                                {roots.length > 1 && (
                                    <Select
                                        value={newFolderRootId}
                                        onValueChange={setNewFolderRootId}
                                    >
                                        <SelectTrigger
                                            className="w-full"
                                            aria-label={i18n("Folder area")}
                                        >
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {roots.map((root) => (
                                                <SelectItem
                                                    key={root.id}
                                                    value={root.id}
                                                >
                                                    {root.scope === "org"
                                                        ? i18n("Organization")
                                                        : i18n("Private")}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                )}
                                <div className="flex justify-end gap-2">
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        disabled={creating}
                                        onClick={() => setNewFolderOpen(false)}
                                    >
                                        {i18n("Cancel")}
                                    </Button>
                                    <Button
                                        type="button"
                                        size="sm"
                                        disabled={
                                            creating || !newFolderName.trim()
                                        }
                                        onClick={() => void createFolder()}
                                    >
                                        {creating && (
                                            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                                        )}
                                        {i18n("Create")}
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <Select
                                value={folderId}
                                onValueChange={(value) =>
                                    void selectFolder(value)
                                }
                                disabled={mode === "profile"}
                            >
                                <SelectTrigger
                                    className="w-full"
                                    aria-label={i18n("Folder")}
                                >
                                    <SelectValue
                                        placeholder={i18n("Choose a folder")}
                                    />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectGroup>
                                        <SelectLabel>
                                            {i18n("Private")}
                                        </SelectLabel>
                                        {fileableFolders
                                            .filter(
                                                (folder) =>
                                                    folder.scope === "personal",
                                            )
                                            .map((folder) => (
                                                <SelectItem
                                                    key={folder.id}
                                                    value={folder.id}
                                                >
                                                    {folder.path}
                                                </SelectItem>
                                            ))}
                                    </SelectGroup>
                                    {fileableFolders.some(
                                        (folder) => folder.scope === "org",
                                    ) && (
                                        <SelectGroup>
                                            <SelectLabel>
                                                {i18n("Organization")}
                                            </SelectLabel>
                                            {fileableFolders
                                                .filter(
                                                    (folder) =>
                                                        folder.scope === "org",
                                                )
                                                .map((folder) => (
                                                    <SelectItem
                                                        key={folder.id}
                                                        value={folder.id}
                                                    >
                                                        {folder.path}
                                                    </SelectItem>
                                                ))}
                                        </SelectGroup>
                                    )}
                                    <SelectItem value={NEW_FOLDER}>
                                        {i18n("New folder…")}
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                        )}
                        <p className="text-xs text-muted-foreground">
                            {folderHint}
                        </p>
                    </fieldset>

                    <fieldset className="min-w-0 space-y-1.5 rounded-md border p-3">
                        <legend className="px-1 text-sm font-medium">
                            {i18n("Profile")}
                        </legend>
                        <Select
                            value={profileChoice}
                            onValueChange={setProfileChoice}
                            disabled={previewing}
                        >
                            <SelectTrigger
                                ref={profileTrigger}
                                className="w-full"
                                aria-label={i18n("Profile")}
                                data-filing-profile
                            >
                                <SelectValue
                                    placeholder={i18n("Choose a profile")}
                                />
                            </SelectTrigger>
                            <SelectContent>
                                {data.organizationDefault && (
                                    <SelectItem value={ORGANIZATION_DEFAULT}>
                                        {i18n("Organization default ({name})", {
                                            name: data.organizationDefault.name,
                                        })}
                                    </SelectItem>
                                )}
                                {defaultProfileUnavailable && (
                                    <SelectItem
                                        value={UNAVAILABLE_DEFAULT}
                                        disabled
                                    >
                                        {i18n(
                                            "Unavailable Organization profile",
                                        )}
                                    </SelectItem>
                                )}
                                {profileOptions.map((profile) => (
                                    <SelectItem
                                        key={profile.id}
                                        value={profile.id}
                                    >
                                        {profile.name}
                                        {profile.scope === "organization"
                                            ? ` · ${i18n("Organization")}`
                                            : ""}
                                    </SelectItem>
                                ))}
                                <SelectItem value={MANUAL_ONLY}>
                                    {i18n("Nothing automatic")}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                            {defaultProfileUnavailable && (
                                <>
                                    {i18n(
                                        "Your selected Organization profile is unavailable. Choose another default.",
                                    )}{" "}
                                </>
                            )}
                            <a
                                href="/settings#profiles"
                                className="rounded-sm text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                {i18n(
                                    "Manage profiles in Settings → Profiles.",
                                )}
                            </a>
                        </p>
                    </fieldset>
                </div>

                {selectedProfile && selectedDetails?.description?.trim() && (
                    <div className="rounded-md border bg-muted/35 px-3 py-2.5 text-sm text-muted-foreground">
                        <span className="font-medium text-foreground">
                            {selectedProfile.name}:
                        </span>{" "}
                        {selectedDetails.description.trim()}
                    </div>
                )}

                {automationSentence && (
                    <div className="flex gap-2.5 rounded-md border border-[color-mix(in_oklch,var(--step-working)_25%,var(--border))] bg-[color-mix(in_oklch,var(--step-working)_8%,transparent)] px-3 py-2.5 text-sm">
                        <GraduationCap
                            className="mt-0.5 size-4 shrink-0 text-[var(--step-working)]"
                            aria-hidden
                        />
                        <p>{automationSentence}</p>
                    </div>
                )}
            </div>

            <footer className="flex flex-wrap items-center gap-3 border-t bg-muted/15 px-4 py-3 sm:px-5">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                    {i18n("These choices appear in the header after you save.")}
                </p>
                <div className="ml-auto flex items-center gap-2">
                    {kind === "audio" && (
                        <Button
                            type="button"
                            variant="outline"
                            onClick={onTranscribe}
                        >
                            {i18n("Transcribe now")}
                        </Button>
                    )}
                    <Button
                        type="button"
                        disabled={
                            submitting ||
                            previewing ||
                            !folderId ||
                            !profileChoice ||
                            profileChoice === UNAVAILABLE_DEFAULT
                        }
                        onClick={() => void submit()}
                    >
                        {submitting && (
                            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                        )}
                        {kind === "mail"
                            ? i18n("Categorize email")
                            : i18n("Categorize recording")}
                    </Button>
                </div>
            </footer>
        </section>
    );
}
