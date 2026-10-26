// @vitest-environment jsdom

/**
 * The Google Picker setup for choosing an export folder: which views it
 * offers, and what it resolves with when the user picks or cancels.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickDriveFolder } from "@/lib/integrations/google/picker-client";

const FOLDER_MIME = "application/vnd.google-apps.folder";

class FakeDocsView {
    readonly settings: Record<string, unknown> = {};

    constructor(viewId: string) {
        this.settings.viewId = viewId;
    }

    setSelectFolderEnabled(enabled: boolean) {
        this.settings.selectFolderEnabled = enabled;
        return this;
    }

    setIncludeFolders(included: boolean) {
        this.settings.includeFolders = included;
        return this;
    }

    setMimeTypes(mimeTypes: string) {
        this.settings.mimeTypes = mimeTypes;
        return this;
    }

    setParent(parentId: string) {
        this.settings.parent = parentId;
        return this;
    }

    setEnableDrives(enabled: boolean) {
        this.settings.enableDrives = enabled;
        return this;
    }
}

interface FakeResponse {
    action: string;
    docs?: Array<{ id: string; name?: string }>;
}

class FakePickerBuilder {
    readonly views: FakeDocsView[] = [];
    readonly features: string[] = [];
    readonly options: Record<string, string> = {};
    callback: (response: FakeResponse) => void = () => {};
    readonly picker = { setVisible: vi.fn(), dispose: vi.fn() };

    constructor() {
        builders.push(this);
    }

    addView(view: FakeDocsView) {
        this.views.push(view);
        return this;
    }

    enableFeature(feature: string) {
        this.features.push(feature);
        return this;
    }

    setOAuthToken(token: string) {
        this.options.token = token;
        return this;
    }

    setDeveloperKey(key: string) {
        this.options.key = key;
        return this;
    }

    setAppId(appId: string) {
        this.options.appId = appId;
        return this;
    }

    setTitle(title: string) {
        this.options.title = title;
        return this;
    }

    setCallback(callback: (response: FakeResponse) => void) {
        this.callback = callback;
        return this;
    }

    build() {
        return this.picker;
    }
}

const builders: FakePickerBuilder[] = [];

const pickerApi = {
    DocsView: FakeDocsView,
    PickerBuilder: FakePickerBuilder,
    ViewId: { FOLDERS: "folders" },
    Feature: { SUPPORT_DRIVES: "sdr" },
    Action: { PICKED: "picked", CANCEL: "cancel" },
};

const credentials = { accessToken: "access", apiKey: "key", appId: "123" };

async function openPicker() {
    const result = pickDriveFolder(credentials, "Choose a folder");
    await vi.waitFor(() => expect(builders).toHaveLength(1));
    return { builder: builders[0], result };
}

beforeEach(() => {
    builders.length = 0;
    Object.assign(window, {
        gapi: {
            load(_name: string, options: { callback: () => void }) {
                Object.assign(window, { google: { picker: pickerApi } });
                options.callback();
            },
        },
    });
});

describe("pickDriveFolder", () => {
    it("offers My Drive and shared drives as separate folder views", async () => {
        const { builder, result } = await openPicker();

        expect(builder.views.map((view) => view.settings)).toEqual([
            {
                viewId: "folders",
                selectFolderEnabled: true,
                includeFolders: true,
                mimeTypes: FOLDER_MIME,
                parent: "root",
            },
            {
                viewId: "folders",
                selectFolderEnabled: true,
                includeFolders: true,
                mimeTypes: FOLDER_MIME,
                enableDrives: true,
            },
        ]);
        expect(builder.features).toEqual(["sdr"]);
        expect(builder.options).toEqual({
            token: "access",
            key: "key",
            appId: "123",
            title: "Choose a folder",
        });
        expect(builder.picker.setVisible).toHaveBeenCalledWith(true);

        builder.callback({ action: "cancel" });
        await expect(result).resolves.toBeNull();
        expect(builder.picker.dispose).toHaveBeenCalled();
    });

    it("resolves with the picked folder", async () => {
        const { builder, result } = await openPicker();

        builder.callback({ action: "loaded" });
        builder.callback({
            action: "picked",
            docs: [{ id: "folder-1", name: "Exports" }],
        });

        await expect(result).resolves.toEqual({
            id: "folder-1",
            name: "Exports",
        });
        expect(builder.picker.dispose).toHaveBeenCalledTimes(1);
    });
});
