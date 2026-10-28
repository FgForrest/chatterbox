import { useExtracted } from "next-intl";
import {
    type FolderExportConfigurationDto,
    WRITER_NO_LONGER_CURATOR,
} from "@/lib/folder-exports/types";

export function useFolderExportLabel() {
    const i18n = useExtracted();
    return (configuration: FolderExportConfigurationDto) => {
        const target = configuration.googleDrive
            ? i18n("Google Drive: {folder}", {
                  folder: configuration.googleDrive.rootFolderName,
              })
            : configuration.targetPath;
        const writer = configuration.writer
            ? i18n("{target} · written by {writer}", {
                  target,
                  writer: configuration.writer.name,
              })
            : target;
        return configuration.stoppedReason === WRITER_NO_LONGER_CURATOR
            ? i18n(
                  "{export} · Stopped: the writer is no longer an Organization curator.",
                  { export: writer },
              )
            : writer;
    };
}
