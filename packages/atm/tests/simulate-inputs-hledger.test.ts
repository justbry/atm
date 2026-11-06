/**
 * Every candidate journal of seeded histories under seven what-ifs is accepted by hledger (balanced, accounts and commodities
 * declared), has events that balance per commodity, and its credit accounts sum to zero.
 */
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import { buildJournal } from "../src/ledger/journal.js";
import { simulateFromInputs } from "../src/ledger/simulate-inputs.js";
import type { AtmEvent } from "../src/types.js";
import { play, menu as playMenu, SCHOOL } from "./billing-play.js";
import { harness } from "./handler-harness.js";
import { hasHledger, tmp } from "./helpers.js";
import { historyStore } from "./simulate-inputs-history.js";
import { logOf, readStored } from "./simulate-inputs-world.js";

const journalOf = async (events: readonly AtmEvent[]) => {
	const dir = await tmp("rev97-journal");
	const months = [...new Set(events.map((e) => e.date.slice(0, 7)))].sort();
	await mkdir(join(dir, "ledger/b4u"), { recursive: true });
	for (const month of months) {
		const build = buildJournal({ events, month });
		for (const [path, text] of Object.entries(build.files))
			await writeFile(join(dir, path), text);
	}
	return dir;
};
const hledger = (cwd: string, args: string[]) =>
	Bun.spawnSync(["hledger", "-f", "main.journal", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

const candidates = (): { name: string; c: Record<string, unknown> }[] => [
	{ name: "full", c: { policy: { ...DEFAULT_POLICY, upgradeGrant: "full" } } },
	{ name: "none", c: { policy: { ...DEFAULT_POLICY, upgradeGrant: "none" } } },
	{
		name: "noremove",
		c: {
			policy: {
				...DEFAULT_POLICY,
				removeOnFullRefund: false,
				removeOnLostDispute: false,
			},
		},
	},
	{
		name: "allow+1",
		c: {
			menu: {
				...playMenu,
				tiers: playMenu.tiers.map((t) => ({
					...t,
					grants: t.grants.map((g) => ({ ...g, amount: g.amount + 1 })),
				})),
			},
		},
	},
	{
		name: "roll0",
		c: {
			menu: {
				...playMenu,
				tiers: playMenu.tiers.map((t) => ({
					...t,
					grants: t.grants.map((g) => ({
						...g,
						rollover: { max: 0, months: 1 },
					})),
				})),
			},
		},
	},
	{
		name: "no-sparkle-2",
		c: {
			menu: {
				...playMenu,
				tiers: playMenu.tiers.filter((t) => t.id !== "sparkle-2"),
			},
		},
	},
	{ name: "tokyo", c: { menu: { ...playMenu, timeZone: "Asia/Tokyo" } } },
];

test.skipIf(!hasHledger)(
	"hledger accepts every candidate journal",
	async () => {
		let runs = 0;
		let differing = 0;
		const bad: string[] = [];
		let skipped = 0;
		for (let seed = 1000; seed < 1030; seed++) {
			const h = harness();
			const store = historyStore(h, {
				seed,
				style: seed % 3 === 0 ? "plain" : "mixed",
				bumpVersion: false,
			});
			play({ seed, steps: 20, store });
			store.flush();
			const inputs = await readStored(h, "live", SCHOOL);
			if (inputs.inputs.length === 0) continue;
			const events = logOf(h);
			for (const { name, c } of candidates()) {
				let sim: ReturnType<typeof simulateFromInputs>;
				try {
					sim = simulateFromInputs({
						events,
						inputs,
						env: "live",
						school: SCHOOL,
						candidate: c as never,
					});
				} catch (e) {
					skipped += 1;
					if (!String(e).includes("log cannot be replayed"))
						bad.push(`${seed} ${name}: ${String(e).slice(0, 160)}`);
					continue;
				}
				runs += 1;
				if (sim.differences > 0) differing += 1;
				for (const e of sim.events) {
					const by = new Map<string, number>();
					for (const p of e.postings)
						by.set(
							p.commodity,
							(by.get(p.commodity) ?? 0) + Math.round(Number(p.amount) * 100),
						);
					if (![...by.values()].every((v) => v === 0))
						bad.push(
							`${seed} ${name}: event ${e.id} ${e.event_type} unbalanced ${JSON.stringify([...by])}`,
						);
				}
				const cwd = await journalOf(sim.events);
				const check = hledger(cwd, [
					"check",
					"balanced",
					"accounts",
					"commodities",
				]);
				if (check.exitCode !== 0 || check.stderr.toString() !== "")
					bad.push(
						`${seed} ${name}: hledger ${check.stderr.toString().slice(0, 200)}`,
					);
				const credits = hledger(cwd, [
					"bal",
					"credits:",
					"--flat",
					"-O",
					"csv",
				]);
				const last = credits.stdout.toString().trim().split("\n").at(-1);
				if (credits.exitCode === 0 && !/^"Total:","0"$/.test(last ?? ""))
					bad.push(`${seed} ${name}: credits total ${last}`);
				// the identity of the unchanged journal for transactions count
				const dup = new Set<string>();
				for (const e of sim.events) {
					if (dup.has(e.id)) bad.push(`${seed} ${name}: duplicate id ${e.id}`);
					dup.add(e.id);
				}
			}
		}
		expect(runs).toBeGreaterThan(100);
		expect(differing).toBeGreaterThan(30);
		void skipped;
		expect(bad).toEqual([]);
	},
	600000,
);
