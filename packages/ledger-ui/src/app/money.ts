const formats = new Map<string, Intl.NumberFormat>();
const formatFor = (currency: string, whole: boolean): Intl.NumberFormat => {
	const key = `${currency}:${whole}`;
	const known = formats.get(key);
	if (known) return known;
	const made = new Intl.NumberFormat("en-US", {
		style: "currency",
		currency,
		...(whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}),
	});
	formats.set(key, made);
	return made;
};

/** Minor units as the mockup's `money` writes them: `$1,234.50`, `−$50.00` (a real minus sign); `whole` drops the
 * cents, for money the cell rules round. */
export function formatMoney(
	cents: number,
	currency: string,
	whole = false,
): string {
	return `${cents < 0 ? "−" : ""}${formatFor(currency, whole).format(Math.abs(cents) / 100)}`;
}

/** A signed whole number as the mockup's `sgn` writes it: `+22`, `−2`, and nothing for 0. */
export function signedCount(count: number): string {
	if (count === 0) return "";
	return count > 0 ? `+${count}` : `−${Math.abs(count)}`;
}
