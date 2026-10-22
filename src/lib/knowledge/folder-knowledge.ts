import type { readFolderKnowledge } from "@/lib/knowledge/read-folder-knowledge";

export const FOLDER_KNOWLEDGE_TABS = [
    "people",
    "things",
    "corrections",
    "facts",
    "models",
] as const;
export type FolderKnowledgeTab = (typeof FOLDER_KNOWLEDGE_TABS)[number];
export const FOLDER_KNOWLEDGE_PAGE_SIZE = 50;
export const FOLDER_KNOWLEDGE_PREVIEW_TERMS = 8;

export type FolderKnowledgeResponse = Awaited<
    ReturnType<typeof readFolderKnowledge>
>;
