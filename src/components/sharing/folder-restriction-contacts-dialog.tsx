"use client";

import { FolderLock } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import type { RecordingFolder } from "@/types/folder";
import { useRestrictedFolderRequest } from "./restricted-folder-api";

interface Contact {
    id: string;
    name: string | null;
    email: string;
}
interface Contacts {
    curators: Contact[];
    creator: Contact | null;
}

/** Explain existing-folder restrictions and show readers whom they can contact. */
export function FolderRestrictionContactsDialog({
    folder,
    onOpenChange,
}: {
    folder: RecordingFolder;
    onOpenChange: (open: boolean) => void;
}) {
    const i18n = useExtracted();
    const request = useRestrictedFolderRequest();
    const [contacts, setContacts] = useState<Contacts | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let cancelled = false;
        setContacts(null);
        setFailed(false);
        if (folder.access !== false)
            void request<Contacts>(
                `/api/folders/${encodeURIComponent(folder.id)}/restriction-contacts`,
            ).then(
                (data) => {
                    if (!cancelled) setContacts(data);
                },
                () => {
                    if (!cancelled) setFailed(true);
                },
            );
        return () => {
            cancelled = true;
        };
    }, [folder.id, folder.access, request]);
    if (folder.access === false) return null;
    const creator =
        contacts?.creator &&
        !contacts.curators.some((person) => person.id === contacts.creator?.id)
            ? contacts.creator
            : null;
    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent
                showCloseButton={false}
                className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"
            >
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <FolderLock className="size-5 text-restricted" />
                        {i18n("Restrict this folder")}
                    </DialogTitle>
                    <DialogDescription>{folder.name}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4 text-sm">
                    <p>
                        {i18n(
                            "Only curators of the Organization and the folder's creator can restrict an existing folder, because restricting withdraws other people's items from the Organization.",
                        )}
                    </p>
                    {!contacts && !failed && (
                        <output>{i18n("Loading…")}</output>
                    )}
                    {failed && (
                        <p role="alert" className="text-destructive">
                            {i18n("Could not load contacts. Please try again.")}
                        </p>
                    )}
                    {contacts &&
                        (contacts.curators.length ? (
                            <>
                                <section className="space-y-2">
                                    <h3 className="font-medium">
                                        {i18n("Curators who can restrict it:")}
                                    </h3>
                                    <ul className="space-y-2">
                                        {contacts.curators.map((person) => (
                                            <li key={person.id}>
                                                <ContactDetails
                                                    person={person}
                                                />
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                                {creator && (
                                    <section className="space-y-2">
                                        <h3 className="font-medium">
                                            {i18n("Created by:")}
                                        </h3>
                                        <ContactDetails person={creator} />
                                        <p className="text-muted-foreground">
                                            {i18n(
                                                "The creator can also restrict this folder.",
                                            )}
                                        </p>
                                    </section>
                                )}
                            </>
                        ) : (
                            <p>
                                {i18n(
                                    "Ask the Organization's administrator to restrict this folder.",
                                )}
                            </p>
                        ))}
                    <p className="text-muted-foreground">
                        {i18n(
                            "Any member can create a new restricted subfolder in an Organization folder: choose “New subfolder”, then “Restricted folder”.",
                        )}
                    </p>
                </div>
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        {i18n("Close")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function ContactDetails({ person }: { person: Contact }) {
    return (
        <div>
            {person.name && <p>{person.name}</p>}
            <a
                className="break-all text-muted-foreground underline"
                href={`mailto:${person.email}`}
            >
                {person.email}
            </a>
        </div>
    );
}
