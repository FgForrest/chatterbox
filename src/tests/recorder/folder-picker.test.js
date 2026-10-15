import { describe, expect, it } from "vitest";
import { mapRecorderFolders } from "../../../extensions/recorder/lib/api.js";

describe("recorder folder picker mapping", () => {
    it("keeps valid folders, sorts by scope and path, and builds labels", () => {
        expect(
            mapRecorderFolders({
                data: [
                    {
                        id: "org",
                        name: "Sales",
                        path: "Organization / Sales",
                        scope: "org",
                    },
                    { id: "bad", name: "Missing scope", path: "Missing scope" },
                    {
                        id: "personal",
                        name: "Calls",
                        path: "Private / Calls",
                        scope: "personal",
                    },
                ],
            }),
        ).toEqual([
            {
                id: "personal",
                label: "Private / Calls",
                name: "Calls",
                path: "Private / Calls",
                scope: "personal",
            },
            {
                id: "org",
                label: "Organization / Sales",
                name: "Sales",
                path: "Organization / Sales",
                scope: "org",
            },
        ]);
    });
});
