"use client";

import { Command, defaultFilter } from "cmdk";
import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import {
    ActionsGroup,
    Kbd,
    PaletteFooter,
    RECORDING_CAP,
    RecordingsGroup,
    recordingPaletteValue,
    ThemeGroup,
} from "@/components/dashboard/command-palette-parts";
import { PaletteSearchResults } from "@/components/dashboard/palette-search-results";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { DateTimeFormat } from "@/lib/format-date";
import type {
    AppSearchResults,
    AppSearchScope,
    ChatterSearchHit,
    PageSearchScope,
} from "@/lib/search/types";
import { cn } from "@/lib/utils";
import type { Recording } from "@/types/recording";
import "@/components/dashboard/command-palette.css";

interface TranscriptionData {
    text?: string;
    readText?: string;
    language?: string;
}

const EMPTY_RECORDINGS: Recording[] = [];
const EMPTY_TRANSCRIPTIONS = new Map<string, TranscriptionData>();
const EMPTY_ACTIONS = new Map<string, "transcribing" | "summarizing">();
const EMPTY_RESULTS: AppSearchResults = {
    chatter: [],
    almanac: [],
    tasks: [],
    limited: false,
};
const noop = () => {};

interface CommandPaletteProps {
    pageScope?: PageSearchScope;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    recordings?: Recording[];
    transcriptions?: Map<string, TranscriptionData>;
    currentRecording?: Recording | null;
    inFlightActions?: Map<string, "transcribing" | "summarizing">;
    currentTheme: "light" | "dark" | "system";
    dateTimeFormat: DateTimeFormat;
    onSelectRecording?: (r: Recording) => void;
    onOpenSearchHit?: (hit: ChatterSearchHit) => boolean;
    onSync: () => void;
    onUpload: () => void;
    onOpenSettings: () => void;
    onOpenShortcuts: () => void;
    onSetTheme: (t: "light" | "dark" | "system") => void;
    onTranscribeRecording?: (id: string) => void;
}

export function CommandPalette({
    pageScope = "chatter",
    open,
    onOpenChange,
    recordings = EMPTY_RECORDINGS,
    transcriptions = EMPTY_TRANSCRIPTIONS,
    currentRecording = null,
    inFlightActions = EMPTY_ACTIONS,
    currentTheme,
    dateTimeFormat,
    onSelectRecording = noop,
    onOpenSearchHit,
    onSync,
    onUpload,
    onOpenSettings,
    onOpenShortcuts,
    onSetTheme,
    onTranscribeRecording = noop,
}: CommandPaletteProps) {
    const i18n = useExtracted();
    const { push } = useRouter();
    const [scope, setScope] = useState<AppSearchScope>(pageScope);
    const [query, setQuery] = useState("");
    const [response, setResponse] = useState<{
        key: string;
        results: AppSearchResults;
    } | null>(null);
    const [failedKey, setFailedKey] = useState<string | null>(null);
    const requestKey = `${scope}:${query.trim()}`;
    const results =
        response?.key === requestKey ? response.results : EMPTY_RESULTS;
    const loading =
        query.trim().length !== 1 &&
        response?.key !== requestKey &&
        failedKey !== requestKey;
    const showChatter = scope === "chatter" || scope === "all";
    const scopeLabel =
        pageScope === "almanac"
            ? i18n("Almanac")
            : pageScope === "tasks"
              ? i18n("Tasks")
              : i18n("Chatter");
    useEffect(() => {
        if (!open) return;
        setScope(pageScope);
        setQuery("");
        setActiveValue("");
        setResponse(null);
        setFailedKey(null);
    }, [open, pageScope]);
    useEffect(() => {
        if (!open || query.trim().length === 1) return;
        const controller = new AbortController();
        const timer = setTimeout(() => {
            const params = new URLSearchParams({ scope, q: query.trim() });
            void fetch(`/api/app-search?${params}`, {
                signal: controller.signal,
            })
                .then((res) => {
                    if (!res.ok) throw new Error();
                    return res.json() as Promise<AppSearchResults>;
                })
                .then((data) => {
                    if (!controller.signal.aborted)
                        setResponse({ key: requestKey, results: data });
                })
                .catch(() => {
                    if (!controller.signal.aborted) setFailedKey(requestKey);
                });
        }, 180);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [open, scope, query, requestKey]);

    const runAction = (fn: () => void) => () => {
        onOpenChange(false);
        setTimeout(fn, 0);
    };

    const visibleRecordings = recordings.slice(0, RECORDING_CAP);

    const [activeValue, setActiveValue] = useState("");

    const transcribeTargets = useMemo(() => {
        const map = new Map<string, string>();
        for (const r of visibleRecordings) {
            if (r.hasTranscript) continue;
            if (inFlightActions.get(r.id) === "transcribing") continue;
            const value = recordingPaletteValue(
                r,
                transcriptions.get(r.id),
                results.chatter.some((hit) => hit.id === r.id)
                    ? query
                    : undefined,
            );
            map.set(value, r.id);
        }
        return map;
    }, [
        visibleRecordings,
        inFlightActions,
        transcriptions,
        results.chatter,
        query,
    ]);

    const transcribeTargetsRef = useRef(transcribeTargets);
    transcribeTargetsRef.current = transcribeTargets;
    const onTranscribeRef = useRef(onTranscribeRecording);
    onTranscribeRef.current = onTranscribeRecording;

    const handleKeyDownCapture = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Tab") {
            e.preventDefault();
            setScope((current) => (current === "all" ? pageScope : "all"));
            setActiveValue("");
            return;
        }
        if (!showChatter) return;
        if (e.key !== "Enter" || (!e.metaKey && !e.ctrlKey)) return;
        const id = transcribeTargetsRef.current.get(activeValue);
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        onTranscribeRef.current(id);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className="max-w-xl gap-0 overflow-hidden p-0"
                showCloseButton={false}
                aria-describedby={undefined}
            >
                <DialogTitle className="sr-only">
                    {i18n("Command palette")}
                </DialogTitle>
                <Command
                    className="command-palette"
                    filter={(value, search, keywords) =>
                        keywords?.includes("server-match")
                            ? 1
                            : defaultFilter(value, search, keywords)
                    }
                    label={i18n("Command palette")}
                    value={activeValue}
                    onValueChange={setActiveValue}
                    onKeyDownCapture={handleKeyDownCapture}
                >
                    <div className="cmd-input-row">
                        <Search
                            className="cmd-input-icon size-4"
                            aria-hidden="true"
                        />
                        <Command.Input
                            value={query}
                            onValueChange={setQuery}
                            maxLength={200}
                            aria-label={i18n("Search")}
                            placeholder={
                                scope === "all"
                                    ? i18n("Search everywhere…")
                                    : pageScope === "almanac"
                                      ? i18n("Search people, things, or terms…")
                                      : pageScope === "tasks"
                                        ? i18n("Search tasks…")
                                        : i18n(
                                              "Search recordings, transcripts, or actions…",
                                          )
                            }
                        />
                        <Kbd>{i18n("⌘K")}</Kbd>
                    </div>

                    <fieldset
                        className="flex items-center gap-2 border-b px-3 py-2"
                        aria-label={i18n("Search scope")}
                    >
                        {[
                            { value: pageScope, label: scopeLabel },
                            {
                                value: "all" as const,
                                label: i18n("Everywhere"),
                            },
                        ].map((entry) => (
                            <button
                                key={entry.value}
                                type="button"
                                aria-pressed={scope === entry.value}
                                className={cn(
                                    "rounded-full px-3 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring",
                                    scope === entry.value
                                        ? "bg-primary/15 text-primary"
                                        : "bg-muted text-muted-foreground",
                                )}
                                onClick={() => {
                                    setScope(entry.value);
                                    setActiveValue("");
                                }}
                            >
                                {entry.label}
                            </button>
                        ))}
                        <span className="ml-auto text-xs text-muted-foreground">
                            <Kbd>Tab</Kbd> {i18n("switch scope")}
                        </span>
                        <span className="sr-only" aria-live="polite">
                            {i18n("Search scope")}:{" "}
                            {scope === "all" ? i18n("Everywhere") : scopeLabel}
                        </span>
                    </fieldset>
                    <Command.List className="max-h-[60vh] overflow-y-auto p-2">
                        <output className="px-3 text-xs text-muted-foreground">
                            {loading
                                ? i18n("Searching…")
                                : failedKey === requestKey
                                  ? i18n("Could not search. Try again.")
                                  : results.limited
                                    ? i18n(
                                          "More results may be available. Refine your search.",
                                      )
                                    : null}
                        </output>
                        {!loading && (
                            <Command.Empty>
                                {i18n("No matches.")}{" "}
                                <div className="cmd-empty-hint">
                                    {i18n(
                                        "Try searching by something you talked about.",
                                    )}
                                </div>
                            </Command.Empty>
                        )}

                        {showChatter && (
                            <>
                                <RecordingsGroup
                                    query={query}
                                    serverMatches={
                                        new Map(
                                            results.chatter.map((hit) => [
                                                hit.id,
                                                hit.snippet,
                                            ]),
                                        )
                                    }
                                    recordings={visibleRecordings}
                                    transcriptions={transcriptions}
                                    currentRecording={currentRecording}
                                    inFlightActions={inFlightActions}
                                    dateTimeFormat={dateTimeFormat}
                                    onSelectRecording={onSelectRecording}
                                    onTranscribeRecording={
                                        onTranscribeRecording
                                    }
                                    runAction={runAction}
                                />

                                <ActionsGroup
                                    onSync={onSync}
                                    onUpload={onUpload}
                                    onOpenSettings={onOpenSettings}
                                    onOpenShortcuts={onOpenShortcuts}
                                    runAction={runAction}
                                />

                                <ThemeGroup
                                    currentTheme={currentTheme}
                                    onSetTheme={onSetTheme}
                                    runAction={runAction}
                                />
                            </>
                        )}
                        <PaletteSearchResults
                            results={results}
                            scope={scope}
                            localRecordingIds={
                                showChatter
                                    ? new Set(
                                          visibleRecordings.map(
                                              (recording) => recording.id,
                                          ),
                                      )
                                    : new Set()
                            }
                            onSelectChatter={(hit) =>
                                runAction(() => {
                                    if (!onOpenSearchHit?.(hit)) push(hit.href);
                                })()
                            }
                            onSelect={(href) => runAction(() => push(href))()}
                        />
                    </Command.List>

                    <PaletteFooter
                        showTranscribeHint={
                            showChatter && transcribeTargets.size > 0
                        }
                    />
                </Command>
            </DialogContent>
        </Dialog>
    );
}
