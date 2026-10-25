import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    closeCornerNotice,
    showCornerNotice,
} from "@/components/dashboard/corner-notice";

const toast = vi.hoisted(() => ({ custom: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const arrival = () => createElement("p", null, "arrival");
const invitation = () => createElement("p", null, "invitation");

beforeEach(() => {
    closeCornerNotice("arrival");
    closeCornerNotice("invitation");
    vi.clearAllMocks();
});

describe("the dashboard's one corner notice", () => {
    it("keeps an invitation in place while an arrival waits behind it", () => {
        showCornerNotice("invitation", invitation);
        showCornerNotice("arrival", arrival);
        expect(toast.custom).toHaveBeenLastCalledWith(
            invitation,
            expect.objectContaining({ id: "new-item", duration: Infinity }),
        );

        closeCornerNotice("invitation");
        expect(toast.custom).toHaveBeenLastCalledWith(
            arrival,
            expect.objectContaining({ id: "new-item" }),
        );
        expect(toast.dismiss).not.toHaveBeenCalled();

        closeCornerNotice("arrival");
        expect(toast.dismiss).toHaveBeenCalledWith("new-item");
    });

    it("replaces an arrival with an invitation and leaves the slot alone for a kind not shown", () => {
        showCornerNotice("arrival", arrival);
        showCornerNotice("invitation", invitation);
        expect(toast.custom).toHaveBeenLastCalledWith(
            invitation,
            expect.anything(),
        );
        closeCornerNotice("arrival");
        expect(toast.custom).toHaveBeenLastCalledWith(
            invitation,
            expect.anything(),
        );
        expect(toast.dismiss).not.toHaveBeenCalled();
    });
});
