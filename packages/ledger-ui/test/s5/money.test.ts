import { expect, test } from "bun:test";
import { currencySymbol, formatMoney } from "../../src/app/money.ts";
import { capitalise, plural } from "../../src/app/wording.ts";

test("USD is $ and CAD is C$, as the mockup writes them, in one rule for every figure", () => {
	expect(currencySymbol("USD")).toBe("$");
	expect(currencySymbol("CAD")).toBe("C$");
	expect(formatMoney(8500, "CAD")).toBe("C$85.00");
	expect(formatMoney(-12345, "CAD")).toBe("−C$123.45");
	expect(formatMoney(123_456, "USD")).toBe("$1,234.56");
	expect(formatMoney(1_250_000, "CAD", true)).toBe("C$12,500");
});

test("the shared wording helpers", () => {
	expect(capitalise("gift")).toBe("Gift");
	expect(plural(1, "event")).toBe("1 event");
	expect(plural(2, "event")).toBe("2 events");
	expect(plural(0, "event")).toBe("0 events");
});
