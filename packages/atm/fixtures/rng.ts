import { createHash } from "node:crypto";

/** A seeded generator (mulberry32). The same seed gives the same sequence on every machine. */
export const makeRng = (seed: number | string) => {
	const digest = createHash("sha256").update(String(seed)).digest();
	let a = digest.readUInt32LE(0);
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
		pick: <T>(items: readonly T[]): T =>
			items[Math.floor(next() * items.length)] as T,
		id: (len = 6) => {
			const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
			let s = "";
			for (let i = 0; i < len; i++)
				s += chars[Math.floor(next() * chars.length)];
			return s;
		},
	};
};
