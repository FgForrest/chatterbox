export type FolderKind = "private" | "public" | "custom";

/** `personal` folders belong to their owner; `org` folders to the Organization. */
export type FolderScope = "personal" | "org";

export interface RecordingFolder {
    id: string;
    parentId: string | null;
    name: string;
    kind: FolderKind;
    sortOrder: number;
    scope: FolderScope;
    /** Optimistic-lock version; sent back on rename and move. */
    version: number;
    restricted?: true;
    access?: boolean;
    managers?: { name: string | null }[];
    accessRequest?: "none" | "pending" | "declined";
    restricting?: true;
    restrictedRole?: "manager" | "member" | "curator";
    sharedWithPeople?: boolean;
    insideSharedFolder?: boolean;
    receivedFolder?: {
        sourceFolderId?: string;
        shareId: string;
        shareVersion: number;
        ownerName: string;
        originalName: string;
    };
}

export interface RecordingFolderAssignment {
    recordingId: string;
    folderId: string;
}

export interface FolderOrganization {
    folders: RecordingFolder[];
    assignments: RecordingFolderAssignment[];
}
