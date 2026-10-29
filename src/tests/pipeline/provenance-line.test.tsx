// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProvenanceLine } from "@/components/pipeline/provenance-line";

afterEach(cleanup);

describe("ProvenanceLine", () => {
    it("skips falsy items and separates only the remaining items", () => {
        const { container } = render(
            <ProvenanceLine
                items={[
                    { key: "null", content: null },
                    { key: "first", content: <span>First</span> },
                    { key: "false", content: false },
                    { key: "zero", content: 0 },
                    { key: "empty", content: "" },
                    { key: "last", content: <span>Last</span> },
                    { key: "undefined", content: undefined },
                ]}
            />,
        );
        const line = container.firstElementChild;
        expect(line?.textContent).toBe("First·Last");
        expect(line?.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
        expect(line?.children).toHaveLength(2);
        expect(line?.firstElementChild?.textContent).toBe("First");
        const last = line?.lastElementChild;
        expect(last?.textContent).toBe("·Last");
        expect(last?.firstElementChild?.getAttribute("aria-hidden")).toBe(
            "true",
        );
    });

    it("renders a single item without a separator", () => {
        const { container } = render(
            <ProvenanceLine items={[{ key: "only", content: "Only" }]} />,
        );
        expect(container.textContent).toBe("Only");
        expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    });

    it("renders no separators when every item is absent", () => {
        const { container } = render(
            <ProvenanceLine items={[{ key: "absent", content: null }]} />,
        );
        expect(container.firstElementChild?.childNodes).toHaveLength(0);
    });
});
