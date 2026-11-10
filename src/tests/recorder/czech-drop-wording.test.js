import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const catalog = (locale) =>
    JSON.parse(
        readFileSync(
            `extensions/recorder/_locales/${locale}/messages.json`,
            "utf8",
        ),
    );

it("uses Zahodit for dropping a task and keeps Zrušit for Cancel in Czech", () => {
    const cs = catalog("cs");
    expect(cs.agendaDrop.message).toBe("Zahodit");
    expect(cs.agendaDropped.message).toBe("Zahozeno");
    expect(cs.cancel.message).toBe("Zrušit");
    const zrusit = Object.entries(cs)
        .filter(([, value]) => /^Zruš(it|eno)$/.test(value.message))
        .map(([key]) => key);
    expect(zrusit).toEqual(["cancel"]);
});
