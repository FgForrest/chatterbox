import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const presentationSource = readFileSync(
    new URL("../../lib/pipeline/presentation.ts", import.meta.url),
    "utf8",
);
const recordingRouteSource = readFileSync(
    new URL("../../app/api/recordings/[id]/route.ts", import.meta.url),
    "utf8",
);

describe("processing presentation hot paths", () => {
    it("keeps the header projection independent of panel-only loaders", () => {
        expect(presentationSource).not.toContain("listFolderOrganization");
        expect(presentationSource).not.toContain("listProfiles");
        expect(presentationSource).not.toContain("resolveProfileForPlacements");
    });

    it("does not select the summary text for the current-summary flag", () => {
        expect(presentationSource).not.toMatch(
            /summary:\s*aiEnhancements\.summary/,
        );
    });

    it("computes processing once across the audio detail and indicator reads", () => {
        expect(
            recordingRouteSource.match(/loadPrivateItemProcessing\(/g),
        ).toHaveLength(1);
    });
});
