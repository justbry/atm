#!/usr/bin/env bun
/**
 * One-command release of the library: a tarball on a GitHub release, which B4 Uni's family service pins by URL
 * (`"atm": "https://github.com/justbry/atm/releases/download/atm-v<version>/atm-<version>.tgz"`, with the tarball's
 * sha512 in its bun.lock).
 *
 *   bun run --cwd packages/atm release [--dry-run]
 *
 * Reads the version from package.json. A real run refuses unless the working tree is clean, HEAD is on origin, and
 * neither tag `atm-v<version>` nor a GitHub release for it exists. Then it builds into a temp dir, runs the dist
 * checks and tests/dist.test.ts against that output, stages the publish package, packs it, prints the tarball's
 * sha256 and the sha512 integrity bun.lock will record, and creates the release at HEAD. The same commit always gives
 * the same tarball bytes (fixed file times, no random content).
 *
 * `--dry-run` does everything but create the release; a check that a real run would refuse on is printed, not fatal.
 * `--ci` is for the tag-push workflow: the tag already exists, HEAD must be that tag, and an existing release is
 * accepted when its asset is byte-for-byte what this build makes.
 */
import { createHash } from "node:crypto";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const here = import.meta.dir;
const repoRoot = resolve(here, "../..");

export const REPO = "justbry/atm";
export const TAG_PREFIX = "atm-v";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** npm's fixed file time, so a pack does not depend on when the files were written. */
const FIXED_TIME = new Date("1985-10-26T08:15:00Z");

/** What the tarball holds, and nothing else. */
export const PACKAGE_FILES = [
	"package/LICENSE",
	"package/README.md",
	"package/dist/index.d.ts",
	"package/dist/index.js",
	"package/dist/types.d.ts",
	"package/dist/worker.d.ts",
	"package/dist/worker.js",
	"package/package.json",
] as const;

/** The package.json inside the tarball: no dependencies (the engine is inlined), no bin, no scripts. */
export const publishManifest = (version: string) => ({
	name: "atm",
	version,
	license: "Apache-2.0",
	repository: {
		type: "git",
		url: "git+https://github.com/justbry/atm.git",
		directory: "packages/atm",
	},
	type: "module",
	main: "./dist/index.js",
	types: "./dist/index.d.ts",
	exports: {
		".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
		"./worker": { types: "./dist/worker.d.ts", default: "./dist/worker.js" },
	},
	files: ["dist"],
	sideEffects: false,
});

export const publishReadme = ({
	version,
	commit,
}: {
	version: string;
	commit: string;
}) =>
	[
		"# atm",
		"",
		"Autumn's balance engine as a typed library: engine commands, the school ledger and the billing rules (menu, Stripe facts, credit grants, storage rows), bundled into one ESM file with no dependencies. `dist/index.d.ts` and `dist/types.d.ts` stand alone.",
		"",
		`Version ${version}, built from commit ${commit} of https://github.com/justbry/atm (packages/atm), a fork of https://github.com/sidgaikwad/autumn. Apache-2.0.`,
		"",
	].join("\n");

/** Writes the publish package into `stageDir`: the built library, LICENSE, README, package.json, all at one fixed time. */
export const stage = ({
	distDir,
	stageDir,
	version,
	commit,
}: {
	distDir: string;
	stageDir: string;
	version: string;
	commit: string;
}): void => {
	mkdirSync(join(stageDir, "dist"), { recursive: true });
	for (const file of [
		"index.js",
		"index.d.ts",
		"types.d.ts",
		"worker.js",
		"worker.d.ts",
	])
		cpSync(join(distDir, file), join(stageDir, "dist", file));
	cpSync(join(repoRoot, "LICENSE"), join(stageDir, "LICENSE"));
	writeFileSync(
		join(stageDir, "package.json"),
		`${JSON.stringify(publishManifest(version), null, 2)}\n`,
	);
	writeFileSync(
		join(stageDir, "README.md"),
		publishReadme({ version, commit }),
	);
	const touch = (path: string) => {
		utimesSync(path, FIXED_TIME, FIXED_TIME);
		if (statSync(path).isDirectory())
			for (const entry of readdirSync(path)) touch(join(path, entry));
	};
	touch(stageDir);
};

/** `bun pm pack` of a staged package; returns the tarball's path. */
export const pack = ({
	stageDir,
	outDir,
	version,
}: {
	stageDir: string;
	outDir: string;
	version: string;
}): string => {
	mkdirSync(outDir, { recursive: true });
	const filename = `atm-${version}.tgz`;
	const run = Bun.spawnSync(
		[
			"bun",
			"pm",
			"pack",
			"--quiet",
			"--ignore-scripts",
			"--destination",
			outDir,
		],
		{ cwd: stageDir, stdout: "pipe", stderr: "pipe" },
	);
	if (run.exitCode !== 0)
		throw new Error(`bun pm pack failed: ${run.stderr.toString()}`);
	return join(outDir, filename);
};

/** sha256 (hex) and the sha512 integrity string (`sha512-<base64>`) that a bun.lock records for the tarball. */
export const digests = (
	file: string,
): { sha256: string; integrity: string } => {
	const bytes = readFileSync(file);
	return {
		sha256: createHash("sha256").update(bytes).digest("hex"),
		integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
	};
};

/** The files in a tarball, sorted, directories left out. */
export const listTarball = (file: string): string[] => {
	const run = Bun.spawnSync(["tar", "-tzf", file], { stdout: "pipe" });
	if (run.exitCode !== 0) throw new Error(`tar could not read ${file}`);
	return run.stdout
		.toString()
		.split("\n")
		.filter((line) => line !== "" && !line.endsWith("/"))
		.sort();
};

/** The runtime names `index.d.ts` exports (types are re-exported from `types.d.ts`; they are counted, not listed). */
export const exportedNames = ({
	index,
	types,
}: {
	index: string;
	types: string;
}): { values: string[]; typeCount: number } => ({
	values: [
		...index.matchAll(/^export declare (?:const|function|class) (\w+)/gm),
	]
		.map((m) => m[1] as string)
		.sort(),
	typeCount: [...types.matchAll(/^export (?:type|interface) (\w+)/gm)].length,
});

export const releaseNotes = ({
	version,
	commit,
	sha256,
	integrity,
	api,
}: {
	version: string;
	commit: string;
	sha256: string;
	integrity: string;
	api: ReturnType<typeof exportedNames>;
}) =>
	[
		`Library build of packages/atm at ${commit}: Autumn's balance engine, the school ledger and the billing rules, bundled into one ESM file. Used by B4 Uni's family service as a pinned dependency.`,
		"",
		`Asset: \`atm-${version}.tgz\`, sha256 \`${sha256}\`, integrity \`${integrity}\` (what bun.lock records).`,
		"",
		`Exports (${api.values.length} values, ${api.typeCount} types in \`dist/types.d.ts\`): ${api.values.map((n) => `\`${n}\``).join(", ")}.`,
		"",
		`Built with bun ${Bun.version}; the same commit on that bun gives the same tarball.`,
		"",
		"Install: set the dependency to the asset URL, then `bun install`:",
		"",
		`\`"atm": "https://github.com/${REPO}/releases/download/${TAG_PREFIX}${version}/atm-${version}.tgz"\``,
	].join("\n");

// ---- the command ------------------------------------------------------------------------------------------------

const run = (
	cmd: string[],
	cwd = repoRoot,
): { ok: boolean; out: string; err: string } => {
	const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	return {
		ok: r.exitCode === 0,
		out: r.stdout.toString().trim(),
		err: r.stderr.toString().trim(),
	};
};

/** What stops a real run: dirty tree, HEAD not on origin, a tag or release that exists. */
const preflight = ({
	version,
	ci,
}: {
	version: string;
	ci: boolean;
}): string[] => {
	const problems: string[] = [];
	const tag = `${TAG_PREFIX}${version}`;
	// The bundler and the packer are part of the bytes: a release is only reproducible on the bun the repo pins.
	const pinned = /^bun@(.+)$/.exec(
		(
			JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
				packageManager?: string;
			}
		).packageManager ?? "",
	)?.[1];
	if (pinned && pinned !== Bun.version)
		problems.push(
			`bun ${Bun.version} is running this, but the repo pins bun ${pinned} (packageManager): the tarball would not be reproducible`,
		);
	if (!SEMVER.test(version))
		problems.push(
			`package.json version ${JSON.stringify(version)} is not semver`,
		);
	if (run(["git", "status", "--porcelain"]).out !== "")
		problems.push("the working tree has uncommitted changes");
	const head = run(["git", "rev-parse", "HEAD"]).out;
	if (ci) {
		const tagged = run(["git", "rev-parse", `${tag}^{commit}`]);
		if (!tagged.ok || tagged.out !== head)
			problems.push(`HEAD is not the commit tag ${tag} points at`);
		return problems;
	}
	run(["git", "fetch", "--quiet", "origin"]);
	const onRemote = run(["git", "branch", "-r", "--contains", head]);
	if (!onRemote.ok || onRemote.out === "")
		problems.push(
			`HEAD ${head.slice(0, 9)} is not on any branch of origin: push it first`,
		);
	if (run(["git", "tag", "-l", tag]).out !== "")
		problems.push(`tag ${tag} already exists locally`);
	const remoteTag = run([
		"git",
		"ls-remote",
		"--tags",
		"origin",
		`refs/tags/${tag}`,
	]);
	if (!remoteTag.ok)
		problems.push("could not ask origin whether the tag exists");
	else if (remoteTag.out !== "")
		problems.push(`tag ${tag} already exists on origin`);
	const release = run(["gh", "release", "view", tag, "--repo", REPO]);
	if (release.ok) problems.push(`a GitHub release for ${tag} already exists`);
	else if (!/release not found/i.test(release.err))
		problems.push(
			`could not ask GitHub whether release ${tag} exists: ${release.err}`,
		);
	return problems;
};

const main = async () => {
	const args = new Set(process.argv.slice(2));
	const dryRun = args.has("--dry-run");
	const ci = args.has("--ci");
	const unknown = [...args].filter((a) => a !== "--dry-run" && a !== "--ci");
	if (unknown.length > 0)
		throw new Error(`unknown argument ${unknown.join(" ")}`);

	const { version } = JSON.parse(
		readFileSync(join(here, "package.json"), "utf8"),
	) as { version: string };
	const tag = `${TAG_PREFIX}${version}`;
	const commit = run(["git", "rev-parse", "HEAD"]).out;

	const problems = preflight({ version, ci });
	if (problems.length > 0) {
		const label = dryRun ? "a real run would refuse" : "refusing";
		for (const p of problems) console.error(`${label}: ${p}`);
		if (!dryRun) process.exit(1);
	}

	const work = mkdtempSync(join(tmpdir(), "atm-release-"));
	const distDir = join(work, "dist");
	const build = Bun.spawnSync(["bun", join(here, "build.ts"), distDir], {
		stdout: "inherit",
		stderr: "inherit",
	});
	if (build.exitCode !== 0) throw new Error("the build failed");
	const checks = Bun.spawnSync(["bun", "test", "tests/dist.test.ts"], {
		cwd: here,
		env: { ...process.env, ATM_DIST: distDir },
		stdout: "inherit",
		stderr: "inherit",
	});
	if (checks.exitCode !== 0)
		throw new Error("tests/dist.test.ts failed on the built output");

	const tarball = (name: string) => {
		const stageDir = join(work, `stage-${name}`);
		stage({ distDir, stageDir, version, commit });
		return pack({ stageDir, outDir: join(work, `out-${name}`), version });
	};
	const first = tarball("a");
	const second = tarball("b");
	const one = digests(first);
	if (one.sha256 !== digests(second).sha256)
		throw new Error(
			"two packs of the same build differ: the tarball is not reproducible",
		);
	const files = listTarball(first);
	if (JSON.stringify(files) !== JSON.stringify([...PACKAGE_FILES]))
		throw new Error(
			`the tarball holds ${files.join(", ")}, not exactly the expected files`,
		);

	console.log(`\ntag       ${tag}  (commit ${commit})`);
	console.log(`tarball   ${first}`);
	for (const f of files) console.log(`  ${f}`);
	console.log(`sha256    ${one.sha256}`);
	console.log(`sha512    ${one.integrity}`);
	console.log("a second pack gave the same bytes");

	const api = exportedNames({
		index: readFileSync(join(distDir, "index.d.ts"), "utf8"),
		types: readFileSync(join(distDir, "types.d.ts"), "utf8"),
	});
	const notes = releaseNotes({ version, commit, ...one, api });
	if (dryRun) {
		console.log("\ndry run: nothing was created. Release notes would be:\n");
		console.log(notes);
		return;
	}

	if (ci) {
		const existing = run(["gh", "release", "view", tag, "--repo", REPO]);
		if (existing.ok) {
			const dir = join(work, "published");
			const got = run([
				"gh",
				"release",
				"download",
				tag,
				"--repo",
				REPO,
				"--pattern",
				`atm-${version}.tgz`,
				"--dir",
				dir,
			]);
			if (!got.ok)
				throw new Error(`could not download the published asset: ${got.err}`);
			const published = digests(join(dir, `atm-${version}.tgz`));
			if (published.sha256 !== one.sha256)
				throw new Error(
					`the published ${tag} asset (${published.sha256}) is not what this commit builds (${one.sha256})`,
				);
			console.log(
				`release ${tag} already exists and its asset is exactly this build`,
			);
			return;
		}
		const created = run([
			"gh",
			"release",
			"create",
			tag,
			first,
			"--repo",
			REPO,
			"--verify-tag",
			"--title",
			`atm ${version}`,
			"--notes",
			notes,
		]);
		if (!created.ok) throw new Error(created.err);
		console.log(created.out);
		return;
	}
	const created = run([
		"gh",
		"release",
		"create",
		tag,
		first,
		"--repo",
		REPO,
		"--target",
		commit,
		"--title",
		`atm ${version}`,
		"--notes",
		notes,
	]);
	if (!created.ok) throw new Error(created.err);
	console.log(`\n${created.out}\n`);
	console.log("In buzz-school, set packages/family-service/package.json to:");
	console.log(
		`  "atm": "https://github.com/${REPO}/releases/download/${tag}/atm-${version}.tgz"`,
	);
	console.log("then run `bun install` (bun.lock records the sha512 above).");
};

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
