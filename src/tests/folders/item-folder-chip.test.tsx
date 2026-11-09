// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ItemFolderChip } from "@/components/items/item-folder-chip";
import { ItemFolderChipBody } from "@/components/items/item-folder-chip-body";

vi.mock("next-intl", () => ({
    useExtracted: () => (_message: string, values: { folder: string }) =>
        `Remove from ${values.folder}`,
}));
afterEach(cleanup);

describe.each([
    false,
    true,
])("web item folder chip organization=%s", (organization) => {
    it("preserves the existing header markup and actions", () => {
        const onSelect = vi.fn();
        const onRemove = vi.fn();
        const { container, rerender } = render(
            <ItemFolderChip
                name="Planning"
                organization={organization}
                onSelect={onSelect}
                onRemove={onRemove}
            />,
        );
        expect(container.innerHTML).toMatchSnapshot();
        fireEvent.click(screen.getByRole("button", { name: "Planning" }));
        fireEvent.click(
            screen.getByRole("button", { name: "Remove from Planning" }),
        );
        expect(onSelect).toHaveBeenCalledOnce();
        expect(onRemove).toHaveBeenCalledOnce();
        rerender(
            <ItemFolderChip
                name="Planning"
                organization={organization}
                onSelect={onSelect}
                onRemove={onRemove}
                disabled
            />,
        );
        expect(
            screen
                .getByRole("button", { name: "Planning" })
                .hasAttribute("disabled"),
        ).toBe(false);
        expect(
            screen
                .getByRole("button", { name: "Remove from Planning" })
                .hasAttribute("disabled"),
        ).toBe(true);
    });
    it("renders the same markup through the provider-free body", () => {
        const { container, rerender } = render(
            <ItemFolderChip
                name="Planning"
                organization={organization}
                onSelect={() => {}}
            />,
        );
        const markup = container.innerHTML;
        rerender(
            <ItemFolderChipBody
                name="Planning"
                organization={organization}
                onSelect={() => {}}
                removeLabel="Remove from Planning"
            />,
        );
        expect(container.innerHTML).toBe(markup);
    });
});
