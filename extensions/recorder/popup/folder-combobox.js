import "./folder-combobox-shared.js";

/** Bind the recorder folder autocomplete to popup controls. */
export const createFolderCombobox = globalThis.recorderFolders.createFolderCombobox;

/** Mount the shared folder field in an idle or recording view. */
export const createFolderField = globalThis.recorderFolders.createFolderField;

/** Bind a shared folder field to the current recording's target. */
export const createRecordingFolder = globalThis.recorderFolders.createRecordingFolder;
