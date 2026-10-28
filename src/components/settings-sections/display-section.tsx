"use client";

import { Monitor } from "lucide-react";
import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { TimeZoneField } from "@/components/settings/time-zone-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useSettings } from "@/hooks/use-settings";
import type { AppLocale } from "@/lib/i18n/config";

export function DisplaySection() {
    const t = useExtracted();
    const router = useRouter();
    const [timeZone, setTimeZone] = useState<string | null>(null);
    const [organization, setOrganization] = useState<{
        timeZone: string | null;
        canManage: boolean;
        isOrganizationAccount?: boolean;
    } | null>(null);
    const { isLoadingSettings, isSavingSettings, setIsLoadingSettings } =
        useSettings();
    const [uiLocale, setUiLocale] = useState<AppLocale | "auto">("auto");
    const [dateTimeFormat, setDateTimeFormat] = useState("relative");
    const [recordingListSortOrder, setRecordingListSortOrder] =
        useState("newest");
    const [itemsPerPage, setItemsPerPage] = useState(50);
    const [theme, setTheme] = useState("system");
    const saveTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
    const localeOptions: Array<{
        label: string;
        value: AppLocale | "auto";
        description?: string;
    }> = [
        {
            label: t("Browser default"),
            value: "auto",
            description: t("Use the language preferred by this browser"),
        },
        { label: t("English"), value: "en" },
        { label: t("Czech"), value: "cs-CZ" },
    ];
    const dateTimeFormatOptions = [
        {
            label: t("Relative"),
            value: "relative",
            description: t("e.g., 2 hours ago"),
        },
        {
            label: t("Absolute"),
            value: "absolute",
            description: t("e.g., Jan 15, 2024 3:45 PM"),
        },
        {
            label: "ISO",
            value: "iso",
            description: t("e.g., 2024-01-15T15:45:00Z"),
        },
    ];
    const sortOrderOptions = [
        { label: t("Newest first"), value: "newest" },
        { label: t("Oldest first"), value: "oldest" },
        { label: t("By name"), value: "name" },
        { label: t("Duration, longest first"), value: "duration" },
        { label: t("Size, largest first"), value: "size" },
    ];
    const themeOptions = [
        { label: t("Light"), value: "light" },
        { label: t("Dark"), value: "dark" },
        {
            label: t("System"),
            value: "system",
            description: t("Follow system preference"),
        },
    ];

    useEffect(() => {
        const fetchSettings = async () => {
            try {
                const response = await fetch("/api/settings/user");
                if (response.ok) {
                    const data = await response.json();
                    setUiLocale(data.uiLocale ?? "auto");
                    setTimeZone(data.timeZone ?? null);
                    setDateTimeFormat(data.dateTimeFormat ?? "relative");
                    setRecordingListSortOrder(
                        data.recordingListSortOrder ?? "newest",
                    );
                    setItemsPerPage(data.itemsPerPage ?? 50);
                    setTheme(data.theme ?? "system");
                }
            } catch (error) {
                console.error("Failed to fetch settings:", error);
            } finally {
                setIsLoadingSettings(false);
            }
        };
        fetchSettings();
        void fetch("/api/settings/organization")
            .then(async (response) => {
                if (response.ok) setOrganization(await response.json());
            })
            .catch(() => {});
    }, [setIsLoadingSettings]);

    useEffect(() => {
        return () => {
            if (saveTimeoutRef.current) {
                clearTimeout(saveTimeoutRef.current);
            }
        };
    }, []);

    const handleDisplaySettingChange = async (
        updates: {
            dateTimeFormat?: string;
            recordingListSortOrder?: string;
            itemsPerPage?: number;
            theme?: string;
            uiLocale?: AppLocale | null;
            timeZone?: string | null;
        },
        debounceMs?: number,
    ) => {
        const previousValues: Record<string, unknown> = {};
        if (updates.timeZone !== undefined) {
            previousValues.timeZone = timeZone;
            setTimeZone(updates.timeZone);
        }
        if (updates.uiLocale !== undefined) {
            previousValues.uiLocale = uiLocale;
            setUiLocale(updates.uiLocale ?? "auto");
        }
        if (updates.dateTimeFormat !== undefined) {
            previousValues.dateTimeFormat = dateTimeFormat;
            setDateTimeFormat(updates.dateTimeFormat);
        }
        if (updates.recordingListSortOrder !== undefined) {
            previousValues.recordingListSortOrder = recordingListSortOrder;
            setRecordingListSortOrder(updates.recordingListSortOrder);
        }
        if (updates.itemsPerPage !== undefined) {
            previousValues.itemsPerPage = itemsPerPage;
            setItemsPerPage(updates.itemsPerPage);
        }
        if (updates.theme !== undefined) {
            previousValues.theme = theme;
            setTheme(updates.theme);
        }

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
        }

        const performSave = async () => {
            try {
                const response = await fetch("/api/settings/user", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(updates),
                });

                if (!response.ok) {
                    throw new Error("Failed to save settings");
                }
                if (updates.uiLocale !== undefined) {
                    window.location.reload();
                }
                if (updates.timeZone !== undefined) router.refresh();
            } catch {
                if (updates.timeZone !== undefined)
                    setTimeZone(previousValues.timeZone as string | null);
                if (updates.uiLocale !== undefined) {
                    const prev = previousValues.uiLocale;
                    if (prev === "auto" || prev === "en" || prev === "cs-CZ") {
                        setUiLocale(prev);
                    }
                }
                if (updates.dateTimeFormat !== undefined) {
                    const prev = previousValues.dateTimeFormat;
                    if (typeof prev === "string") setDateTimeFormat(prev);
                }
                if (updates.recordingListSortOrder !== undefined) {
                    const prev = previousValues.recordingListSortOrder;
                    if (typeof prev === "string")
                        setRecordingListSortOrder(prev);
                }
                if (updates.itemsPerPage !== undefined) {
                    const prev = previousValues.itemsPerPage;
                    if (typeof prev === "number") setItemsPerPage(prev);
                }
                if (updates.theme !== undefined) {
                    const prev = previousValues.theme;
                    if (typeof prev === "string") setTheme(prev);
                }
                toast.error(t("Failed to save settings. Changes reverted."));
            }
        };

        if (debounceMs) {
            saveTimeoutRef.current = setTimeout(performSave, debounceMs);
        } else {
            performSave();
        }
    };

    if (isLoadingSettings) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="animate-spin size-6 border-2 border-primary border-t-transparent rounded-full" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <SettingsSectionHeader
                title={t("Display")}
                description={t(
                    "How dates, lists, and the overall UI present themselves.",
                )}
                icon={Monitor}
            />
            <div className="space-y-4">
                {!organization?.isOrganizationAccount && (
                    <div className="space-y-2">
                        <p className="text-sm font-medium">{t("Time zone")}</p>
                        <TimeZoneField
                            value={timeZone}
                            onChange={(timeZone) =>
                                void handleDisplaySettingChange({ timeZone })
                            }
                            disabled={isSavingSettings}
                        />
                    </div>
                )}
                {organization?.canManage && (
                    <div className="space-y-2">
                        <p className="text-sm font-medium text-organization">
                            {t("Organization time zone")}
                        </p>
                        <TimeZoneField
                            organization
                            value={organization.timeZone}
                            onChange={async (timeZone) => {
                                const previous = organization;
                                setOrganization({ ...organization, timeZone });
                                try {
                                    const response = await fetch(
                                        "/api/settings/organization",
                                        {
                                            method: "PUT",
                                            headers: {
                                                "Content-Type":
                                                    "application/json",
                                            },
                                            body: JSON.stringify({ timeZone }),
                                        },
                                    );
                                    if (!response.ok)
                                        throw new Error(
                                            "Failed to save settings",
                                        );
                                    router.refresh();
                                } catch {
                                    setOrganization(previous);
                                    toast.error(
                                        t(
                                            "Failed to save settings. Changes reverted.",
                                        ),
                                    );
                                }
                            }}
                        />
                    </div>
                )}
                <div className="space-y-2">
                    <Label htmlFor="ui-language">{t("Language")}</Label>
                    <Select
                        value={uiLocale}
                        onValueChange={(value) => {
                            if (
                                value !== "auto" &&
                                value !== "en" &&
                                value !== "cs-CZ"
                            ) {
                                return;
                            }
                            setUiLocale(value);
                            handleDisplaySettingChange({
                                uiLocale: value === "auto" ? null : value,
                            });
                        }}
                        disabled={isSavingSettings}
                    >
                        <SelectTrigger id="ui-language" className="w-full">
                            <SelectValue>
                                {localeOptions.find(
                                    (option) => option.value === uiLocale,
                                )?.label ?? t("Browser default")}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {localeOptions.map((option) => (
                                <SelectItem
                                    key={option.value}
                                    value={option.value}
                                >
                                    <div>
                                        <div>{option.label}</div>
                                        {option.description ? (
                                            <div className="text-xs text-muted-foreground">
                                                {option.description}
                                            </div>
                                        ) : null}
                                    </div>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="date-time-format">
                        {t("Date/time format")}
                    </Label>
                    <Select
                        value={dateTimeFormat}
                        onValueChange={(value) => {
                            setDateTimeFormat(value);
                            handleDisplaySettingChange({
                                dateTimeFormat: value,
                            });
                        }}
                        disabled={isSavingSettings}
                    >
                        <SelectTrigger id="date-time-format" className="w-full">
                            <SelectValue>
                                {dateTimeFormatOptions.find(
                                    (opt) => opt.value === dateTimeFormat,
                                )?.label || t("Relative")}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {dateTimeFormatOptions.map((option) => (
                                <SelectItem
                                    key={option.value}
                                    value={option.value}
                                >
                                    <div>
                                        <div>{option.label}</div>
                                        <div className="text-xs text-muted-foreground">
                                            {option.description}
                                        </div>
                                    </div>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="sort-order">
                        {t("Recording list sort order")}
                    </Label>
                    <Select
                        value={recordingListSortOrder}
                        onValueChange={(value) => {
                            setRecordingListSortOrder(value);
                            handleDisplaySettingChange({
                                recordingListSortOrder: value,
                            });
                        }}
                        disabled={isSavingSettings}
                    >
                        <SelectTrigger id="sort-order" className="w-full">
                            <SelectValue>
                                {sortOrderOptions.find(
                                    (opt) =>
                                        opt.value === recordingListSortOrder,
                                )?.label || t("Newest first")}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {sortOrderOptions.map((option) => (
                                <SelectItem
                                    key={option.value}
                                    value={option.value}
                                >
                                    {option.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="items-per-page">
                        {t("Items per page")}
                    </Label>
                    <Input
                        id="items-per-page"
                        type="number"
                        min={10}
                        max={100}
                        value={itemsPerPage}
                        onChange={(e) => {
                            const value = parseInt(e.target.value, 10);
                            if (
                                !Number.isNaN(value) &&
                                value >= 10 &&
                                value <= 100
                            ) {
                                setItemsPerPage(value);
                                handleDisplaySettingChange(
                                    { itemsPerPage: value },
                                    500,
                                );
                            }
                        }}
                    />
                    <p className="text-xs text-muted-foreground">
                        {t("Number of recordings to display per page (10-100)")}
                    </p>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="theme">{t("Theme")}</Label>
                    <Select
                        value={theme}
                        onValueChange={(value) => {
                            setTheme(value);
                            handleDisplaySettingChange({ theme: value });
                        }}
                        disabled={isSavingSettings}
                    >
                        <SelectTrigger id="theme" className="w-full">
                            <SelectValue>
                                {themeOptions.find((opt) => opt.value === theme)
                                    ?.label || t("System")}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {themeOptions.map((option) => (
                                <SelectItem
                                    key={option.value}
                                    value={option.value}
                                >
                                    <div>
                                        <div>{option.label}</div>
                                        {option.description && (
                                            <div className="text-xs text-muted-foreground">
                                                {option.description}
                                            </div>
                                        )}
                                    </div>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </div>
        </div>
    );
}
