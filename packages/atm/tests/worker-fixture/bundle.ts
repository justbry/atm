/**
 * Bundles a Worker entry the way Wrangler does (esbuild, the `workerd`/`worker`/`browser` conditions, no Node platform),
 * leaving `node:*` built-ins external because the runtime provides them under `nodejs_compat`.
 */
import { resolve } from "node:path";
import { build, type Metafile } from "esbuild";

const PACKAGE = resolve(import.meta.dir, "../..");

export type WorkerBundle = {
	text: string;
	metafile: Metafile;
	/** Every `node:*` module the bundle imports at run time, sorted. */
	nodeBuiltins: string[];
	/** The package names under `node_modules` that went into the bundle, sorted. */
	packages: string[];
};

const NODE_MODULES = "node_modules/";

const packageOf = (input: string): string | null => {
	const at = input.lastIndexOf(NODE_MODULES);
	if (at === -1) return null;
	const [first, second] = input.slice(at + NODE_MODULES.length).split("/");
	if (first === undefined) return null;
	return first.startsWith("@") ? `${first}/${second}` : first;
};

export const bundleWorker = async (entry: string): Promise<WorkerBundle> => {
	const result = await build({
		absWorkingDir: PACKAGE,
		entryPoints: [entry],
		bundle: true,
		write: false,
		metafile: true,
		platform: "neutral",
		format: "esm",
		conditions: ["workerd", "worker", "browser"],
		mainFields: ["module", "main"],
		external: ["node:*"],
		logLevel: "warning",
		outfile: "worker.js",
	});
	const [output] = Object.values(result.metafile.outputs);
	const [file] = result.outputFiles;
	if (output === undefined || file === undefined)
		throw new Error(`bundling ${entry} produced no output`);
	const nodeBuiltins = new Set<string>();
	for (const imported of output.imports)
		if (imported.external && imported.path.startsWith("node:"))
			nodeBuiltins.add(imported.path);
	const packages = new Set<string>();
	for (const input of Object.keys(result.metafile.inputs)) {
		const name = packageOf(input);
		if (name !== null) packages.add(name);
	}
	return {
		text: file.text,
		metafile: result.metafile,
		nodeBuiltins: [...nodeBuiltins].sort(),
		packages: [...packages].sort(),
	};
};
