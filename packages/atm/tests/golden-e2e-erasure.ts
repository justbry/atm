/**
 * S3: an erasure drill. Three families go through the real handler (copies of the golden `erasure` bundle, each with its own
 * ids and personal strings), their inputs and events are shipped by the command line, one family is erased with the library's
 * `eraseStoredInputs` (there is no command for it), `atm inputs ship` settles the erasure queue, and then every file of the
 * folder, every table of the database and the raw bytes of the database and its `-wal` are searched for what the family's
 * fixtures hold: the personal strings and the ids. A control before the erasure shows the search can find them.
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import { eraseStoredInputs } from "../src/handler/inputs.js";
import {
	loadScenarioBundle,
	resolveBundleDirectory,
} from "../src/scenario/bundle.js";
import type { BundleStep, ScenarioBundle } from "../src/types.js";
import { type RunOptions, step } from "./golden-e2e-cases.js";
import { cloneStep, personalStringsOf } from "./golden-e2e-clone.js";
import {
	buildBundleWorld,
	fingerprint,
	makeWorld,
	Outcomes,
	type World,
} from "./golden-e2e-lib.js";

const FAMILIES = 3;
const DAY_MS = 86_400_000;
const SCHOOL = "sch_vol";
const ERASED_INDEX = 1;

export type Needles = {
	holder: string;
	suffix: string;
	personal: string[];
	/** The ids that name the family: the family id, the Stripe customer and the holder key of the log. */
	identity: string[];
};

/** Where a needle was found: a file of the world (database and `-wal` bytes included) or a table row of the database. */
export type Hits = {
	files: Record<string, number>;
	tables: Record<string, number>;
};

/** Three copies of the `erasure` bundle's story, a few days apart, as one bundle. */
export const erasureDrillBundle = async (
	count = FAMILIES,
): Promise<{
	bundle: ScenarioBundle;
	families: Needles[];
}> => {
	const source = await loadScenarioBundle(resolveBundleDirectory("erasure"));
	const steps: BundleStep[] = [];
	const families: Needles[] = [];
	const fees: Record<string, number> = {};
	const personal = new Set<string>();
	for (let family = 0; family < count; family++) {
		const suffix = family === 0 ? "" : `_c${family}`;
		const copied = source.steps
			.filter((candidate) => candidate.kind !== "erase")
			.map((candidate) =>
				suffix === ""
					? { ...candidate, atMs: candidate.atMs + family * DAY_MS }
					: cloneStep(candidate, suffix, family * DAY_MS),
			);
		steps.push(...copied);
		for (const [invoice, fee] of Object.entries(source.scenario.fees ?? {}))
			if (fee !== null) fees[`${invoice}${suffix}`] = fee;
		const events = copied.flatMap((candidate) =>
			"event" in candidate ? [candidate.event] : [],
		);
		const strings = events.flatMap((event) => personalStringsOf(event));
		for (const text of strings) personal.add(text);
		const familyId = `fam_8k2${suffix}`;
		families.push({
			holder: `family:${familyId}`,
			suffix,
			personal: [...new Set(strings)],
			identity: [familyId, `cus_SYNTH_0001${suffix}`, `family:${familyId}`],
		});
	}
	steps.sort((a, b) => a.atMs - b.atMs);
	return {
		bundle: {
			...source,
			id: "erasure-drill",
			steps,
			scenario: {
				...source.scenario,
				id: "erasure-drill",
				fees,
				personal: [...personal],
			},
			expected: { ...source.expected, answers: [] },
		},
		families,
	};
};

const count = (haystack: string, needle: string): number => {
	let found = 0;
	for (
		let at = haystack.indexOf(needle);
		at !== -1;
		at = haystack.indexOf(needle, at + needle.length)
	)
		found += 1;
	return found;
};

/** Every occurrence of `needle` in the world: per file (bytes) and per table (rows whose columns hold it). */
export const grep = (world: World, school: string, needle: string): Hits => {
	const files: Record<string, number> = {};
	for (const path of Object.keys(fingerprint(world.dir))) {
		const found = count(
			readFileSync(join(world.dir, path)).toString("latin1"),
			needle,
		);
		if (found > 0) files[path] = found;
	}
	const tables: Record<string, number> = {};
	const database = new Database(world.databaseFor(school), { readonly: true });
	try {
		const names = (
			database
				.query(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
				)
				.all() as { name: string }[]
		).map((row) => row.name);
		for (const name of names) {
			let rows = 0;
			for (const row of database.query(`SELECT * FROM ${name}`).all())
				if (JSON.stringify(row).includes(needle)) rows += 1;
			if (rows > 0) tables[name] = rows;
		}
	} finally {
		database.close();
	}
	return { files, tables };
};

/** A path of the world, class by where it sits: what the doc's table groups by. */
export const placeOf = (path: string): string => {
	if (path.startsWith("db/")) {
		if (path.endsWith("-wal")) return "sqlite -wal";
		if (path.endsWith("-shm")) return "sqlite -shm";
		return "sqlite file";
	}
	if (path.includes("/inputs/")) return "folder inputs/";
	if (path.includes("/events/")) return "folder events/";
	if (path.includes("/ledger/") || path.endsWith("main.journal"))
		return "folder journals";
	return "other";
};

const summary = (hits: Hits): string => {
	const places: Record<string, number> = {};
	for (const [path, found] of Object.entries(hits.files))
		places[placeOf(path)] = (places[placeOf(path)] ?? 0) + found;
	const parts = [
		...Object.entries(places).map(([place, found]) => `${place} x${found}`),
		...Object.entries(hits.tables).map(
			([table, rows]) => `table ${table} ${rows} row(s)`,
		),
	];
	return parts.length === 0 ? "nowhere" : parts.join(", ");
};

export type ErasureReport = {
	holder: string;
	/** needle class -> where it was before and after, as text, for the doc. */
	table: { needle: string; before: string; after: string }[];
	settled: number;
	otherHolders: string;
	rawBytes: { step: string; where: string }[];
};

export const checkErasure = async (
	options: RunOptions,
): Promise<{ rec: Outcomes; report: ErasureReport }> => {
	const rec = new Outcomes("erasure-drill");
	const { bundle, families } = await erasureDrillBundle();
	const world = await makeWorld("erasure");
	const erased = families[ERASED_INDEX] as Needles;
	const kept = families.filter((_, index) => index !== ERASED_INDEX);
	const report: ErasureReport = {
		holder: erased.holder,
		table: [],
		settled: 0,
		otherHolders: "",
		rawBytes: [],
	};
	try {
		await buildBundleWorld(bundle, world);
		const database = world.databaseFor(SCHOOL);
		const inputsShip = [
			"inputs",
			"ship",
			"--db",
			database,
			"--school",
			SCHOOL,
			"--env",
			"live",
			"--root",
			world.root,
			"--json",
		];
		step(rec, "inputs ship (before the erasure)", inputsShip, options);
		step(
			rec,
			"ship (before the erasure)",
			["ship", "--db", database, "--root", world.root, "--school", SCHOOL],
			options,
		);
		const simulate = [
			"simulate",
			"--root",
			world.root,
			"--school",
			SCHOOL,
			"--inputs",
			database,
			"--env",
			"live",
			"--json",
		];
		const beforeSimulate = step(
			rec,
			"simulate (before)",
			simulate,
			options,
			[0],
		);
		const beforeFolder = step(
			rec,
			"simulate folder (before)",
			[...simulate.slice(0, 6), world.root, "--env", "live", "--json"],
			options,
		);
		rec.expect(
			"simulate before: database and folder agree",
			beforeSimulate.stdout === beforeFolder.stdout,
			() => "differ",
		);
		const beforeJson = JSON.parse(beforeSimulate.stdout) as {
			baseline: { identical: boolean; inputs: number };
			replayed: { holders: number };
			notReplayable: { holders: number };
		};
		rec.expect(
			"before: every family replayed, baseline identical",
			beforeJson.baseline.identical && beforeJson.replayed.holders >= FAMILIES,
			() => beforeSimulate.stdout.slice(0, 1600),
		);

		// ---- the control: the search can find what is there ----
		const needles: { name: string; text: string }[] = [
			...erased.personal.map((text) => ({ name: "personal", text })),
			...erased.identity.map((text) => ({ name: `id ${text}`, text })),
		];
		const before = new Map<string, Hits>();
		for (const needle of needles)
			before.set(needle.text, grep(world, SCHOOL, needle.text));

		// what the erased rows hold, to look for in the bytes afterwards
		const probe = new Database(database, { readonly: true });
		const signatures = (
			probe
				.query(
					"SELECT raw_sha256, body, payment_refs, batch_key FROM atm_event_inputs WHERE subject_key = ?",
				)
				.all(`${SCHOOL}|live|${erased.holder}`) as {
				raw_sha256: string | null;
				body: string | null;
				payment_refs: string | null;
				batch_key: string | null;
			}[]
		).flatMap((row) =>
			[row.raw_sha256, row.body].filter(
				(text): text is string => typeof text === "string",
			),
		);
		const oldBatches = (
			probe
				.query(
					"SELECT DISTINCT batch_key FROM atm_event_inputs WHERE subject_key = ? AND batch_key IS NOT NULL",
				)
				.all(`${SCHOOL}|live|${erased.holder}`) as { batch_key: string }[]
		).map((row) => row.batch_key);
		probe.close();
		rec.expect(
			"before: the erased holder has stored facts to look for",
			signatures.length > 0 && oldBatches.length > 0,
			() => `${signatures.length} signatures, ${oldBatches.length} batches`,
		);

		// ---- the erasure: one holder, in a transaction, as the family service would ----
		const raw = new Database(database);
		raw.exec("PRAGMA busy_timeout = 5000");
		const db = bunSqlite(raw);
		const erasedResult = db.transaction(() =>
			eraseStoredInputs(db, {
				env: "live",
				school: SCHOOL,
				subjectKey: `${SCHOOL}|live|${erased.holder}`,
				nowMs: Date.parse("2026-03-01T00:00:00Z"),
			}),
		);
		raw.close();
		rec.expect(
			"eraseStoredInputs: inputs tombstoned, batches queued",
			erasedResult.inputs > 0 && erasedResult.queued > 0,
			() => JSON.stringify(erasedResult),
		);
		const settle = step(
			rec,
			"inputs ship (settle the erasure)",
			inputsShip,
			options,
		);
		const settled = JSON.parse(settle.stdout) as {
			erasuresSettled: number;
			erasuresPending: number;
			ok: boolean;
		};
		report.settled = settled.erasuresSettled;
		rec.expect(
			"inputs ship: erasures settled and none pending",
			settled.erasuresSettled > 0 &&
				settled.erasuresPending === 0 &&
				settled.ok,
			() => settle.stdout.slice(0, 300),
		);
		step(rec, "inputs ship (rerun)", inputsShip, options);

		// ---- grep everything ----
		for (const needle of needles) {
			const after = grep(world, SCHOOL, needle.text);
			report.table.push({
				needle: needle.name,
				before: summary(before.get(needle.text) as Hits),
				after: summary(after),
			});
		}
		rec.expect(
			"control: the family's personal strings were never in the database or the folder (nothing to erase)",
			erased.personal.every(
				(text) => summary(before.get(text) as Hits) === "nowhere",
			),
			() =>
				erased.personal
					.map((text) => `${text}: ${summary(before.get(text) as Hits)}`)
					.join("; "),
		);
		rec.expect(
			"control: the family's ids were findable before the erasure",
			erased.identity.every(
				(text) => summary(before.get(text) as Hits) !== "nowhere",
			),
			() => "an id was not found before: the search proves nothing",
		);
		for (const text of erased.personal)
			rec.expect(
				`after: personal string ${JSON.stringify(text)} is nowhere`,
				summary(grep(world, SCHOOL, text)) === "nowhere",
				() => summary(grep(world, SCHOOL, text)),
			);
		// the shipped objects that held the facts are gone, and what replaced them holds no fact
		for (const key of oldBatches)
			rec.expect(
				`after: the old batch ${key.split("/").slice(-2).join("/")} is deleted`,
				!existsSync(join(world.root, key)),
				() => "still on disk",
			);
		const signatureHits = (): Record<string, number> => {
			const out: Record<string, number> = {};
			for (const path of Object.keys(fingerprint(world.dir))) {
				const text = readFileSync(join(world.dir, path)).toString("latin1");
				const found = signatures.filter((signature) =>
					text.includes(signature),
				).length;
				if (found > 0) out[path] = found;
			}
			return out;
		};
		const live = signatureHits();
		rec.expect(
			"after: no erased fact (body, raw_sha256) is in any file of the folder",
			Object.keys(live).every((path) => path.startsWith("db/")),
			() => JSON.stringify(live),
		);
		const rawBytesBefore = `${
			Object.entries(live)
				.map(([path, found]) => `${path} ${found}/${signatures.length}`)
				.join(", ") || "none"
		}`;
		report.rawBytes = [
			{ step: "after erase + settle (WAL as it is)", where: rawBytesBefore },
		];
		if (Object.keys(live).length > 0)
			rec.finding(
				"after: an erased fact is still in the raw bytes of the SQLite file or its -wal",
				rawBytesBefore,
			);
		const maintenance = new Database(database);
		maintenance.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		maintenance.close();
		const checkpointed = signatureHits();
		report.rawBytes.push({
			step: "after PRAGMA wal_checkpoint(TRUNCATE)",
			where:
				Object.entries(checkpointed)
					.map(([path, found]) => `${path} ${found}/${signatures.length}`)
					.join(", ") || "none",
		});
		const vacuum = new Database(database);
		vacuum.exec("VACUUM");
		vacuum.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		vacuum.close();
		const vacuumed = signatureHits();
		report.rawBytes.push({
			step: "after VACUUM + checkpoint",
			where:
				Object.entries(vacuumed)
					.map(([path, found]) => `${path} ${found}/${signatures.length}`)
					.join(", ") || "none",
		});
		// the ids: the design removes them from the inputs (folder and tables); the log and the engine rows keep them
		for (const id of erased.identity) {
			const hits = grep(world, SCHOOL, id);
			const inFolderInputs = Object.keys(hits.files).filter(
				(path) => placeOf(path) === "folder inputs/",
			);
			rec.expect(
				`after: ${id} is in no file under inputs/`,
				inFolderInputs.length === 0,
				() => inFolderInputs.join(", "),
			);
			rec.expect(
				`after: ${id} is in no stored-input table row`,
				!(
					"atm_event_inputs" in hits.tables ||
					"atm_input_seeds" in hits.tables ||
					"atm_input_contexts" in hits.tables
				),
				() => JSON.stringify(hits.tables),
			);
		}

		// ---- the simulate after: the erased holder is not replayable, the others are as they were ----
		const afterDatabase = step(
			rec,
			"simulate (after, db)",
			simulate,
			options,
			[0, 1],
		);
		const afterFolder = step(
			rec,
			"simulate (after, folder)",
			[...simulate.slice(0, 6), world.root, "--env", "live", "--json"],
			options,
			[0, 1],
		);
		rec.expect(
			"simulate after: database and folder print the same",
			afterDatabase.stdout === afterFolder.stdout,
			() => "differ",
		);
		const after = JSON.parse(afterDatabase.stdout) as {
			baseline: { identical: boolean };
			replayed: { holders: number };
			notReplayable: {
				holders: number;
				items: { subjectKey?: string; reason: string }[];
			};
			differences: number;
		};
		const erasedItems = after.notReplayable.items.filter(
			(item) => item.reason === "erased",
		);
		rec.expect(
			"simulate after: the erased holder is reported not_replayable (erased), only it",
			erasedItems.length === 1 &&
				after.notReplayable.holders === 1 &&
				after.replayed.holders === beforeJson.replayed.holders - 1,
			() => afterDatabase.stdout.slice(0, 1600),
		);
		rec.expect(
			"simulate after: baseline identical for the others, no difference",
			after.baseline.identical && after.differences === 0,
			() => afterDatabase.stdout.slice(0, 1600),
		);
		report.otherHolders = `${kept.map((family) => family.holder).join(", ")} replayed; ${erased.holder}: ${erasedItems[0]?.reason ?? "?"}`;
	} finally {
		await world.dispose();
	}
	return { rec, report };
};
