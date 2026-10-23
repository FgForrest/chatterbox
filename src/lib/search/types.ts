export type PageSearchScope = "chatter" | "almanac" | "tasks";
export type AppSearchScope = PageSearchScope | "all";

export interface AlmanacSearchHit {
    id: string;
    kind: "person" | "entity" | "glossary";
    name: string;
    typeKey: string;
    typeLabel: string;
    description: string | null;
    scope: "personal" | "org";
    heard: string | null;
    href: string;
}

export interface TaskSearchHit {
    id: string;
    text: string;
    status: "open" | "done";
    dueDate: string | null;
    folder?: { id: string; name: string; path: string } | null;
    recording: {
        id: string;
        title: string;
        view: "private" | "org" | "received";
    } | null;
    href: string;
}

export interface ChatterSearchHit {
    id: string;
    title: string;
    snippet: string | null;
    href: string;
}

export interface AppSearchResults {
    chatter: ChatterSearchHit[];
    almanac: AlmanacSearchHit[];
    tasks: TaskSearchHit[];
    limited: boolean;
}

export function pageSearchScope(pathname: string): PageSearchScope {
    if (pathname.startsWith("/almanac")) return "almanac";
    if (pathname.startsWith("/tasks")) return "tasks";
    return "chatter";
}
