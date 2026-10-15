"use client";

import { useExtracted } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { getApiErrorMessage } from "@/lib/api-errors";
import type {
    CategorizationPanelPresentation,
    ProcessingResolution,
} from "@/lib/pipeline/categorization-presentation";

export type CategorizePanelData = CategorizationPanelPresentation;

export interface CategorizeSubmission {
    folderIds: string[];
    profileId?: string;
    manualOnly?: boolean;
}

interface CategorizePanelProps {
    data: CategorizePanelData;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCategorized?: (folderIds: string[]) => void;
    onOptimisticCategorize?: (submission: CategorizeSubmission) => () => void;
}

const MANUAL_ONLY = "__manual_only__";

function resolutionChoice(resolution: ProcessingResolution): string {
    if (resolution.status !== "resolved") return "";
    return resolution.manualOnly ? MANUAL_ONLY : resolution.profile.id;
}

function initialProfileChoice(data: CategorizePanelData): string {
    if (data.currentProfile) {
        return data.currentManualOnly ? MANUAL_ONLY : data.currentProfile.id;
    }
    return resolutionChoice(data.resolution);
}

function sameFolderSelection(left: string[], right: string[]): boolean {
    if (left.length !== right.length) return false;
    const rightIds = new Set(right);
    return left.every((folderId) => rightIds.has(folderId));
}

export function CategorizePanel({
    data,
    open,
    onOpenChange,
    onCategorized,
    onOptimisticCategorize,
}: CategorizePanelProps) {
    const i18n = useExtracted();
    const [folders, setFolders] = useState(data.folders);
    const [folderIds, setFolderIds] = useState(data.selectedFolderIds);
    const [preview, setPreview] = useState<ProcessingResolution>(
        data.resolution,
    );
    const [profileChoice, setProfileChoice] = useState(
        initialProfileChoice(data),
    );
    const [previewing, setPreviewing] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [creatingFolder, setCreatingFolder] = useState(false);
    const [newFolderOpen, setNewFolderOpen] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");
    const [newFolderParentId, setNewFolderParentId] = useState("");
    const previewError = i18n("The profile preview could not be loaded.");

    useEffect(() => {
        if (!open) return;
        setFolders(data.folders);
        setFolderIds(data.selectedFolderIds);
        setPreview(data.resolution);
        setProfileChoice(initialProfileChoice(data));
        setNewFolderOpen(false);
        setNewFolderName("");
        setNewFolderParentId("");
    }, [data, open]);

    useEffect(() => {
        if (!open) return;
        if (data.currentProfile) {
            setPreview(data.resolution);
            setProfileChoice(initialProfileChoice(data));
            setPreviewing(false);
            return;
        }
        if (sameFolderSelection(folderIds, data.selectedFolderIds)) {
            setPreview(data.resolution);
            setProfileChoice(resolutionChoice(data.resolution));
            setPreviewing(false);
            return;
        }
        if (folderIds.length === 0) {
            setPreview({ status: "choose", candidates: [] });
            setProfileChoice("");
            setPreviewing(false);
            return;
        }

        const controller = new AbortController();
        const timer = window.setTimeout(() => {
            setPreviewing(true);
            void fetch(
                `/api/recordings/${encodeURIComponent(data.itemId)}/categorize/preview`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ folderIds }),
                    signal: controller.signal,
                },
            )
                .then(async (response) => {
                    if (!response.ok) throw new Error(String(response.status));
                    return (await response.json()) as {
                        resolution: ProcessingResolution;
                    };
                })
                .then(({ resolution }) => {
                    setPreview(resolution);
                    setProfileChoice(resolutionChoice(resolution));
                })
                .catch((error: unknown) => {
                    if (controller.signal.aborted) return;
                    setPreview({ status: "choose", candidates: [] });
                    setProfileChoice("");
                    toast.error(previewError);
                    console.error(error);
                })
                .finally(() => {
                    if (!controller.signal.aborted) setPreviewing(false);
                });
        }, 200);
        return () => {
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [data, folderIds, open, previewError]);

    const prefilledChoice = data.currentProfile
        ? initialProfileChoice(data)
        : resolutionChoice(preview);
    const selectedOrganization = folders.some(
        (folder) => folder.scope === "org" && folderIds.includes(folder.id),
    );
    const folderParents = folders.filter(
        (folder) =>
            (folder.scope === "personal" && folder.parentId === null) ||
            (folder.scope === "org" && data.canCreateOrganizationFolders),
    );
    const hasFileableFolder = folders.some(
        (folder) => folder.parentId !== null,
    );
    const profileOptions = useMemo(() => {
        const byId = new Map(
            data.profiles.map((profile) => [profile.id, profile]),
        );
        if (data.currentProfile) {
            byId.set(data.currentProfile.id, data.currentProfile);
        }
        if (preview.status === "choose") {
            for (const candidate of preview.candidates) {
                if (candidate.kind === "profile") {
                    byId.set(candidate.profile.id, candidate.profile);
                }
            }
        } else if (preview.status === "resolved") {
            byId.set(preview.profile.id, preview.profile);
        }
        return [...byId.values()];
    }, [data.currentProfile, data.profiles, preview]);

    const createFolder = async () => {
        const name = newFolderName.trim();
        const parent = folders.find(
            (folder) => folder.id === newFolderParentId,
        );
        if (!name || !parent) return;
        setCreatingFolder(true);
        try {
            const response = await fetch("/api/folders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ parentId: parent.id, name }),
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
                folder: {
                    id: string;
                    parentId: string | null;
                    name: string;
                    scope: "personal" | "org";
                };
            };
            const created = {
                ...folder,
                path: `${parent.path} › ${folder.name}`,
            };
            setFolders((current) => [...current, created]);
            setFolderIds((current) =>
                current.includes(folder.id) ? current : [...current, folder.id],
            );
            if (!data.currentProfile) {
                setPreviewing(true);
                setProfileChoice("");
            }
            setNewFolderName("");
            setNewFolderOpen(false);
            toast.success(i18n("Folder created."));
        } catch {
            toast.error(i18n("The folder could not be created."));
        } finally {
            setCreatingFolder(false);
        }
    };

    const submit = async () => {
        if (folderIds.length === 0 || !profileChoice || previewing) return;
        let rollback: (() => void) | undefined;
        setSubmitting(true);
        try {
            const changed = profileChoice !== prefilledChoice;
            const body: CategorizeSubmission = {
                folderIds,
                ...(changed && profileChoice === MANUAL_ONLY
                    ? { manualOnly: true }
                    : changed
                      ? { profileId: profileChoice }
                      : {}),
            };
            rollback = onOptimisticCategorize?.(body);
            const response = await fetch(
                `/api/recordings/${encodeURIComponent(data.itemId)}/categorize`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
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
            onOpenChange(false);
            toast.success(i18n("Item filed."));
        } catch {
            rollback?.();
            toast.error(i18n("The item could not be filed."));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{i18n("File it")}</DialogTitle>
                    <DialogDescription>
                        {i18n(
                            "Choose where this item belongs. Its folders set the context for processing.",
                        )}
                    </DialogDescription>
                </DialogHeader>

                <fieldset className="max-h-72 space-y-2 overflow-y-auto rounded-md border p-3">
                    <legend className="px-1 text-sm font-medium">
                        {i18n("Folders")}
                    </legend>
                    {!hasFileableFolder && (
                        <p className="px-2 py-1 text-sm text-muted-foreground">
                            {i18n("Create a folder to file this item")}
                        </p>
                    )}
                    {folders.map((folder) => {
                        const root = folder.parentId === null;
                        return (
                            <Label
                                key={folder.id}
                                className="flex items-center gap-2 rounded px-2 py-1.5 font-normal hover:bg-muted/60"
                            >
                                <input
                                    type="checkbox"
                                    aria-label={folder.path}
                                    disabled={root}
                                    checked={folderIds.includes(folder.id)}
                                    onChange={(event) => {
                                        if (!data.currentProfile) {
                                            setPreviewing(true);
                                            setProfileChoice("");
                                        }
                                        setFolderIds((current) =>
                                            event.target.checked
                                                ? [...current, folder.id]
                                                : current.filter(
                                                      (id) => id !== folder.id,
                                                  ),
                                        );
                                    }}
                                />
                                <span>{folder.path}</span>
                            </Label>
                        );
                    })}
                    {newFolderOpen ? (
                        <div className="space-y-3 border-t pt-3">
                            <div className="space-y-1.5">
                                <Label htmlFor="categorize-new-folder-name">
                                    {i18n("Folder name")}
                                </Label>
                                <Input
                                    id="categorize-new-folder-name"
                                    value={newFolderName}
                                    onChange={(event) =>
                                        setNewFolderName(event.target.value)
                                    }
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label>{i18n("Parent folder")}</Label>
                                <Select
                                    value={newFolderParentId}
                                    onValueChange={setNewFolderParentId}
                                >
                                    <SelectTrigger
                                        className="w-full"
                                        aria-label={i18n("Parent folder")}
                                    >
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {folderParents.map((folder) => (
                                            <SelectItem
                                                key={folder.id}
                                                value={folder.id}
                                            >
                                                {folder.path}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="flex justify-end gap-2">
                                <Button
                                    type="button"
                                    variant="ghost"
                                    onClick={() => setNewFolderOpen(false)}
                                    disabled={creatingFolder}
                                >
                                    {i18n("Cancel")}
                                </Button>
                                <Button
                                    type="button"
                                    onClick={() => void createFolder()}
                                    disabled={
                                        creatingFolder ||
                                        !newFolderName.trim() ||
                                        !newFolderParentId
                                    }
                                >
                                    {creatingFolder
                                        ? i18n("Creating…")
                                        : i18n("Create folder")}
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <Button
                            type="button"
                            variant="outline"
                            className="mt-2 w-full"
                            disabled={folderParents.length === 0}
                            onClick={() => {
                                setNewFolderParentId(
                                    folderParents[0]?.id ?? "",
                                );
                                setNewFolderOpen(true);
                            }}
                        >
                            {i18n("New folder")}
                        </Button>
                    )}
                </fieldset>

                <div className="space-y-2">
                    <Label>{i18n("Profile")}</Label>
                    <Select
                        value={profileChoice}
                        onValueChange={setProfileChoice}
                        disabled={previewing}
                    >
                        <SelectTrigger
                            className="w-full"
                            aria-label={i18n("Profile")}
                        >
                            <SelectValue
                                placeholder={i18n("Choose a profile")}
                            />
                        </SelectTrigger>
                        <SelectContent>
                            {profileOptions.map((profile) => (
                                <SelectItem key={profile.id} value={profile.id}>
                                    {profile.name}
                                </SelectItem>
                            ))}
                            <SelectItem value={MANUAL_ONLY}>
                                {i18n("Nothing automatic")}
                            </SelectItem>
                        </SelectContent>
                    </Select>
                    {preview.status === "resolved" && (
                        <p className="text-xs text-muted-foreground">
                            {data.currentProfile
                                ? i18n("Current profile")
                                : preview.source === "folder"
                                  ? i18n("From the folder's default")
                                  : i18n("Your default")}
                        </p>
                    )}
                    {selectedOrganization && (
                        <p className="text-xs text-muted-foreground">
                            {i18n("Organization folders share after review.")}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={submitting}
                    >
                        {i18n("Cancel")}
                    </Button>
                    <Button
                        onClick={() => void submit()}
                        disabled={
                            submitting ||
                            previewing ||
                            folderIds.length === 0 ||
                            !profileChoice
                        }
                    >
                        {submitting ? i18n("Filing…") : i18n("File it")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
