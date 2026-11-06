const formats = new Map<boolean, Intl.NumberFormat>();
const formatFor = (whole: boolean): Intl.NumberFormat => {
	const known = formats.get(whole);
	if (known) return known;
	const digits = whole ? 0 : 2;
	const made = new Intl.NumberFormat("en-US", {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	});
	formats.set(whole, made);
	return made;
};

/** The mockup's `K_CUR`: `$` for USD and `C$` for CAD, matched on the ISO code as the data writes it. Any other code
 * falls back to the symbol `Intl` knows. */
const knownSymbols: Record<string, string> = { USD: "$", CAD: "C$" };

/** The unit of an amount field and the prefix of every money figure: `$` or `C$`. */
export const currencySymbol = (currency: string): string =>
	knownSymbols[currency] ??
	new Intl.NumberFormat("en-US", { style: "currency", currency })
		.formatToParts(0)
		.find(({ type }) => type === "currency")?.value ??
	currency.toUpperCase();

/** Minor units as the mockup's `money` writes them: `$1,234.50`, `−$50.00` (a real minus sign); `whole` drops the
 * cents, for money the cell rules round. */
export function formatMoney(
	cents: number,
	currency: string,
	whole = false,
): string {
	const sign = cents < 0 ? "−" : "";
	return `${sign}${currencySymbol(currency)}${formatFor(whole).format(Math.abs(cents) / 100)}`;
}

/** A signed whole number as the mockup's `sgn` writes it: `+22`, `−2`, and nothing for 0. */
export function signedCount(count: number): string {
	if (count === 0) return "";
	return count > 0 ? `+${count}` : `−${Math.abs(count)}`;
}
