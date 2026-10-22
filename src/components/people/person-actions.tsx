"use client";

import { Merge, Pencil, UserCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { mergeLikelihoods } from "@/components/almanac/merge-likelihoods";
import { MergeTargetPicker } from "@/components/almanac/merge-target-picker";
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
import { getApiErrorMessage, parseApiError } from "@/lib/api-errors";

interface MergeCandidate {
    id: string;
    displayName: string;
    primaryEmail: string | null;
    scope?: "personal" | "org";
    duplicateScore?: number;
}

interface PersonActionsProps {
    person: {
        id: string;
        displayName: string;
        primaryEmail: string | null;
        scope?: "personal" | "org";
    };
    /**
     * The viewer's account email, offered as "This is me" when the person
     * is not the viewer yet.
     */
    accountEmail?: string;
}

/**
 * Rename a person, or fold them into another.
 *
 * Shown only to whoever may change the person: their owner, or for an
 * Organization person the organization account, whose edits reach every
 * recording that names them.
 */
export function PersonActions({ person, accountEmail }: PersonActionsProps) {
    const i18n = useExtracted();
    const router = useRouter();
    const [renaming, setRenaming] = useState(false);
    const [merging, setMerging] = useState(false);
    const [name, setName] = useState(person.displayName);
    const [email, setEmail] = useState(person.primaryEmail ?? "");
    const [candidates, setCandidates] = useState<MergeCandidate[]>([]);
    const [targetId, setTargetId] = useState("");
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!merging) return;
        const controller = new AbortController();
        let likelihoods: Map<string, number> | null = null;
        setCandidates([]);
        void fetch("/api/people", { signal: controller.signal })
            .then(async (response) => {
                const body: { people?: MergeCandidate[] } = response.ok
                    ? await response.json()
                    : {};
                if (controller.signal.aborted) return;
                setCandidates(
                    (body.people ?? [])
                        .filter(
                            (candidate) =>
                                candidate.id !== person.id &&
                                (person.scope !== "org" ||
                                    candidate.scope === "org"),
                        )
                        .map((candidate) => ({
                            ...candidate,
                            duplicateScore: likelihoods
                                ? (likelihoods.get(candidate.id) ?? 0)
                                : undefined,
                        })),
                );
            })
            .catch(() => {});
        if (person.scope === "org") {
            void mergeLikelihoods("person", person.id, controller.signal).then(
                (scores) => {
                    likelihoods = scores;
                    if (!controller.signal.aborted && scores)
                        setCandidates((current) =>
                            current.map((candidate) => ({
                                ...candidate,
                                duplicateScore: scores.get(candidate.id) ?? 0,
                            })),
                        );
                },
            );
        }
        return () => controller.abort();
    }, [merging, person.id, person.scope]);

    async function rename(
        primaryEmail: string | null = email.trim() || null,
        displayName = name,
    ) {
        setSaving(true);
        try {
            const response = await fetch(`/api/people/${person.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ displayName, primaryEmail }),
            });
            if (!response.ok) {
                const error = await parseApiError(response);
                toast.error(
                    error.details?.reason === "internal_mail_address"
                        ? i18n(
                              "An inbound mail address cannot be used as a person's email address.",
                          )
                        : error.error || i18n("Could not save this person"),
                );
                return;
            }
            setRenaming(false);
            router.refresh();
        } finally {
            setSaving(false);
        }
    }

    async function merge() {
        if (!targetId) return;
        setSaving(true);
        try {
            const response = await fetch(`/api/people/${person.id}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mergeIntoId: targetId }),
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not merge these people"),
                    ),
                );
                return;
            }
            const body = (await response.json()) as { person?: { id: string } };
            router.push(`/almanac/${body.person?.id ?? targetId}`);
            router.refresh();
        } finally {
            setSaving(false);
        }
    }

    return (
        <>
            {accountEmail && (
                <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    disabled={saving}
                    title={i18n(
                        "Give this person your account email, so Learn names you as the one who made your recordings.",
                    )}
                    onClick={() =>
                        void rename(accountEmail, person.displayName)
                    }
                >
                    <UserCheck className="mr-2 size-4" /> {i18n("This is me")}
                </Button>
            )}
            <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => {
                    setName(person.displayName);
                    setEmail(person.primaryEmail ?? "");
                    setRenaming(true);
                }}
            >
                <Pencil className="mr-2 size-4" /> {i18n("Rename")}
            </Button>
            <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => {
                    setTargetId("");
                    setMerging(true);
                }}
            >
                <Merge className="mr-2 size-4" /> {i18n("Merge into…")}
            </Button>

            <Dialog open={renaming} onOpenChange={setRenaming}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{i18n("Edit person")}</DialogTitle>
                        <DialogDescription>
                            {person.scope === "org"
                                ? i18n(
                                      "Changes apply to everyone and to every recording that names this person.",
                                  )
                                : i18n(
                                      "Changes apply to every recording that names this person.",
                                  )}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-2">
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            maxLength={200}
                            aria-label={i18n("Name")}
                        />
                        <Input
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            maxLength={320}
                            type="email"
                            placeholder={i18n("Email (optional)")}
                            aria-label={i18n("Email")}
                        />
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            disabled={saving}
                            onClick={() => setRenaming(false)}
                        >
                            {i18n("Cancel")}
                        </Button>
                        <Button
                            disabled={saving || !name.trim()}
                            onClick={() => void rename()}
                        >
                            {i18n("Save")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={merging} onOpenChange={setMerging}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>
                            {i18n("Merge {name} into…", {
                                name: person.displayName,
                            })}
                        </DialogTitle>
                        <DialogDescription>
                            {i18n(
                                "Every recording that names {name} will name the person you choose instead.",
                                { name: person.displayName },
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <MergeTargetPicker
                        source={{
                            id: person.id,
                            name: person.displayName,
                            email: person.primaryEmail,
                            kind: "person",
                        }}
                        value={targetId}
                        onChange={setTargetId}
                        candidates={candidates.map((candidate) => ({
                            id: candidate.id,
                            name: candidate.displayName,
                            email: candidate.primaryEmail,
                            scope: candidate.scope ?? "personal",
                            duplicateScore: candidate.duplicateScore,
                        }))}
                    />
                    <DialogFooter>
                        <Button
                            variant="outline"
                            disabled={saving}
                            onClick={() => setMerging(false)}
                        >
                            {i18n("Cancel")}
                        </Button>
                        <Button
                            disabled={saving || !targetId}
                            onClick={() => void merge()}
                        >
                            {i18n("Merge")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
