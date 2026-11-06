/**
 * The mockup's executable feature spec, `plans/ledger-ui/design/smoke.mjs`, made runnable against any page (protocol v9
 * addendum §3). Shared by the UI harness (`test/parity/harness.ts`) and the table sync
 * (`plans/ledger-ui/loop/tools/parity-sync.ts`).
 *
 * How the file is split and executed. smoke.mjs is parsed with the TypeScript compiler (as JavaScript), never by regex:
 * - The prelude is every top-level statement before the first one that calls `ok(`: the imports, the happy-dom window,
 *   the mockup load and the helpers (`d`, `$`, `$$`, `txt`, `ok`, `tab`, `sc`, ...). The UI side never runs it; it
 *   supplies the same names through the adapter, and re-evaluates the helpers the map marks `prelude` (`tab`, `sc`)
 *   over the adapter's `$`. The mockup side (the sync) runs it as written.
 * - The body is the rest, minus the closing report (top-level statements that name `fails` or `process`). It is
 *   rewritten statement by statement, recursively through bare blocks and loop bodies (not into function bodies):
 *   every statement becomes `await __run(<first line>, <last line>, async () => { <statement> })`, which settles the
 *   page first and catches what the statement throws, so one throwing statement loses only the checks inside it. A
 *   `const`/`let` declaration is hoisted as `let` names at the top of its block and each declarator assigned in its own
 *   step (`(name = init)`, binding patterns included), so later statements still see every name that could be
 *   computed. Function declarations are kept as written. Each `ok(` call becomes `__ok(<its line>, ...)`.
 * - Waits inside a statement: the mockup redraws inside a click, the UI may render on a later task or after a load.
 *   Wherever an `await` is legal (statement level, not inside a callback), every `.click()`, `.dispatchEvent()`,
 *   `tab()`, `sc()` and helper call becomes `(await __after(<call>))`, which settles the page before the statement goes
 *   on. A helper the body declares whose own statements act on the page (`portal`, `va`, `openRow`, ...) also gets an
 *   async twin `<name>__a` with the same waits inside, called at those sites; the sync original stays for callbacks
 *   (`BV.map(l => lvl(l))`), which cannot wait.
 * - A check is one `ok(name, cond, info)` call at run time. Its id is the slug of its name plus an occurrence index
 *   (`<slug>.<n>`, n counting from 1 per slug in run order). Its line is the first line of the innermost step that
 *   called it; a check a UI run never reaches is reported with the error of the step that holds that line.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export const repositoryRoot = join(import.meta.dir, "..", "..", "..", "..");
export const smokePath = join(
	repositoryRoot,
	"plans/ledger-ui/design/smoke.mjs",
);
export const mockupPath = join(
	repositoryRoot,
	"plans/ledger-ui/design/mockup.html",
);
export const tablePath = join(import.meta.dir, "checks.json");
export const mapPath = join(import.meta.dir, "map.json");

/** Slice order (protocol v9 addendum §5): the deltas S0b and S1b come after S1 and before S2. */
export const sliceOrder = [
	"S0",
	"S1",
	"S0b",
	"S1b",
	"S2",
	"S3",
	"S4",
	"S5",
	"S6",
	"S7",
] as const;
export type Slice = (typeof sliceOrder)[number];
export const isSlice = (value: string): value is Slice =>
	(sliceOrder as readonly string[]).includes(value);
/** The slices a gate for `slice` owns: every slice up to it in `sliceOrder`. */
export const slicesUpTo = (slice: Slice): Slice[] =>
	sliceOrder.slice(0, sliceOrder.indexOf(slice) + 1);

export type CompiledSmoke = {
	sha256: string;
	/** `import { a as b } from "x"` statements of the prelude. */
	imports: Array<{
		specifier: string;
		bindings: Array<{ imported: string; local: string }>;
	}>;
	/** The prelude without its imports, runnable as an async function body. */
	preludeSource: string;
	/** Every name the prelude declares, in order. */
	preludeNames: string[];
	/** Each prelude declarator's initializer, by name. */
	preludeInitializers: Record<string, string>;
	/** The rewritten body, runnable as an async function body over `__ok`, `__run` and the prelude names. */
	bodySource: string;
};

const bindingNames = (name: ts.BindingName, into: string[]): void => {
	if (ts.isIdentifier(name)) {
		into.push(name.text);
		return;
	}
	for (const element of name.elements)
		if (!ts.isOmittedExpression(element)) bindingNames(element.name, into);
};

const contains = (
	node: ts.Node,
	test: (candidate: ts.Node) => boolean,
): boolean => {
	if (test(node)) return true;
	return ts.forEachChild(node, (child) => contains(child, test)) ?? false;
};

const isOkCall = (node: ts.Node): node is ts.CallExpression =>
	ts.isCallExpression(node) &&
	ts.isIdentifier(node.expression) &&
	node.expression.text === "ok";

export function compileSmoke(source: string): CompiledSmoke {
	const file = ts.createSourceFile(
		"smoke.mjs",
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.JS,
	);
	const lineOf = (position: number): number =>
		file.getLineAndCharacterOfPosition(position).line + 1;

	const statements = [...file.statements];
	const bodyStart = statements.findIndex((statement) =>
		contains(statement, isOkCall),
	);
	if (bodyStart < 0) throw new Error("smoke.mjs has no ok( call");
	const prelude = statements.slice(0, bodyStart);
	const reportsOnly = (statement: ts.Statement): boolean =>
		!contains(statement, isOkCall) &&
		contains(
			statement,
			(node) =>
				ts.isIdentifier(node) &&
				(node.text === "fails" || node.text === "process"),
		);
	const body = statements
		.slice(bodyStart)
		.filter((statement) => !reportsOnly(statement));

	/** The statements the rewrite steps through: bare blocks and loop bodies, recursively. */
	const stepped = (list: readonly ts.Statement[]): ts.Statement[] =>
		list.flatMap((statement) => {
			if (ts.isBlock(statement))
				return [statement, ...stepped(statement.statements)];
			if (
				(ts.isForOfStatement(statement) ||
					ts.isForInStatement(statement) ||
					ts.isForStatement(statement)) &&
				ts.isBlock(statement.statement)
			)
				return [statement, ...stepped(statement.statement.statements)];
			return [statement];
		});
	const isFunction = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
		ts.isArrowFunction(node) ||
		ts.isFunctionExpression(node) ||
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node);
	/** The nearest function around a node, or null at statement level. */
	const enclosing = (node: ts.Node): ts.Node | null => {
		for (let parent = node.parent; parent; parent = parent.parent)
			if (isFunction(parent)) return parent;
		return null;
	};

	/** Helpers the body declares (`const portal = id => { tab("mem"); row(id)... }`) whose own statements act on the
	 * page. Each also gets an async twin, `<name>__a`, used where the call can be awaited. */
	const helperFunctions = new Map<
		string,
		ts.ArrowFunction | ts.FunctionExpression
	>();
	for (const statement of stepped(body))
		if (ts.isVariableStatement(statement))
			for (const declaration of statement.declarationList.declarations)
				if (
					ts.isIdentifier(declaration.name) &&
					declaration.initializer &&
					(ts.isArrowFunction(declaration.initializer) ||
						ts.isFunctionExpression(declaration.initializer))
				)
					helperFunctions.set(declaration.name.text, declaration.initializer);
	const acts = (call: ts.CallExpression, helpers: Set<string>): boolean => {
		const callee = call.expression;
		if (ts.isPropertyAccessExpression(callee))
			return ["click", "dispatchEvent"].includes(callee.name.text);
		return (
			ts.isIdentifier(callee) &&
			(callee.text === "tab" ||
				callee.text === "sc" ||
				helpers.has(callee.text))
		);
	};
	const helpers = new Set<string>();
	for (let changed = true; changed; ) {
		changed = false;
		for (const [name, fn] of helperFunctions)
			if (
				!helpers.has(name) &&
				contains(
					fn,
					(node) =>
						ts.isCallExpression(node) &&
						enclosing(node) === fn &&
						acts(node, helpers),
				)
			) {
				helpers.add(name);
				changed = true;
			}
	}
	const twins = new Set([...helpers].map((name) => helperFunctions.get(name)));

	/** `ok(` → `__ok(<line>,` everywhere. Where the call can be awaited (statement level, or inside a helper's twin),
	 * every click, dispatchEvent, tab, sc and helper call is wrapped as `(await __after(<call>))`, which waits for the
	 * page to render before the statement reads it; a helper call there calls its twin. Each wait belongs to a region:
	 * null for statement level, else the helper function whose twin carries it. */
	type Edit = {
		start: number;
		end: number;
		text: string;
		region: ts.Node | null | "always";
		/** A wait's closing `))` may sit at the very end of a statement; its opening never does. */
		closes?: true;
	};
	const edits: Edit[] = [];
	const collect = (node: ts.Node): void => {
		if (isOkCall(node)) {
			const start = node.expression.getStart(file);
			const paren = source.indexOf("(", node.expression.end);
			edits.push({
				start,
				end: paren + 1,
				text: `__ok(${lineOf(start)},`,
				region: "always",
			});
		} else if (ts.isCallExpression(node) && acts(node, helpers)) {
			const region = enclosing(node);
			if (region === null || twins.has(region as ts.ArrowFunction)) {
				const start = node.getStart(file);
				edits.push({ start, end: start, text: "(await __after(", region });
				if (
					ts.isIdentifier(node.expression) &&
					helpers.has(node.expression.text)
				)
					edits.push({
						start: node.expression.end,
						end: node.expression.end,
						text: "__a",
						region,
					});
				edits.push({
					start: node.end,
					end: node.end,
					text: "))",
					region,
					closes: true,
				});
			}
		}
		ts.forEachChild(node, collect);
	};
	for (const statement of body) collect(statement);
	edits.sort((first, second) => first.start - second.start);
	const text = (
		start: number,
		end: number,
		region: ts.Node | null = null,
	): string => {
		let out = "";
		let at = start;
		for (const edit of edits) {
			if (edit.start < start || edit.end > end) continue;
			if (
				edit.closes
					? edit.start === start
					: edit.start === end && edit.end === end
			)
				continue;
			if (edit.region !== "always" && edit.region !== region) continue;
			out += source.slice(at, edit.start) + edit.text;
			at = edit.end;
		}
		return out + source.slice(at, end);
	};
	const nodeText = (node: ts.Node, region: ts.Node | null = null): string =>
		text(node.getStart(file), node.end, region);
	/** A loop's step only holds its body's steps, so it gets the long budget; each inner step has its own. */
	const step = (node: ts.Node, inner: string, holdsSteps = false): string =>
		`await __run(${lineOf(node.getStart(file))},${lineOf(node.end)},async()=>{\n${inner}\n}${holdsSteps ? ",true" : ""});`;

	const isAsync = (node: ts.Node): boolean =>
		ts.canHaveModifiers(node) &&
		(ts.getModifiers(node) ?? []).some(
			(modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
		);
	const emitStatements = (list: readonly ts.Statement[]): string => {
		const hoisted: string[] = [];
		const parts = list.map((statement) => emitStatement(statement, hoisted));
		return `${hoisted.length ? `let ${hoisted.join(",")};\n` : ""}${parts.join("\n")}`;
	};
	const emitStatement = (
		statement: ts.Statement,
		hoisted: string[],
	): string => {
		if (ts.isVariableStatement(statement))
			return statement.declarationList.declarations
				.map((declaration) => {
					bindingNames(declaration.name, hoisted);
					if (!declaration.initializer) return "";
					const assign = `(${nodeText(declaration.name)}=${nodeText(declaration.initializer)});`;
					if (
						!ts.isIdentifier(declaration.name) ||
						!helpers.has(declaration.name.text)
					)
						return step(declaration, assign);
					hoisted.push(`${declaration.name.text}__a`);
					return step(
						declaration,
						`${assign}\n(${declaration.name.text}__a=${isAsync(declaration.initializer) ? "" : "async "}${nodeText(declaration.initializer, declaration.initializer)});`,
					);
				})
				.join("\n");
		if (ts.isFunctionDeclaration(statement)) return nodeText(statement);
		if (ts.isEmptyStatement(statement)) return "";
		if (ts.isBlock(statement))
			return `{\n${emitStatements(statement.statements)}\n}`;
		if (
			(ts.isForOfStatement(statement) ||
				ts.isForInStatement(statement) ||
				ts.isForStatement(statement)) &&
			ts.isBlock(statement.statement)
		) {
			const header = text(
				statement.getStart(file),
				statement.statement.getStart(file),
			);
			return step(
				statement,
				`${header}{\n${emitStatements(statement.statement.statements)}\n}`,
				true,
			);
		}
		return step(statement, nodeText(statement));
	};

	const imports: CompiledSmoke["imports"] = [];
	const preludeNames: string[] = [];
	const preludeInitializers: Record<string, string> = {};
	const preludeParts: string[] = [];
	for (const statement of prelude) {
		if (ts.isImportDeclaration(statement)) {
			const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
			const named = statement.importClause?.namedBindings;
			const bindings =
				named && ts.isNamedImports(named)
					? named.elements.map((element) => ({
							imported: (element.propertyName ?? element.name).text,
							local: element.name.text,
						}))
					: [];
			imports.push({ specifier, bindings });
			continue;
		}
		if (ts.isVariableStatement(statement))
			for (const declaration of statement.declarationList.declarations) {
				const names: string[] = [];
				bindingNames(declaration.name, names);
				preludeNames.push(...names);
				if (ts.isIdentifier(declaration.name) && declaration.initializer)
					preludeInitializers[declaration.name.text] = source.slice(
						declaration.initializer.getStart(file),
						declaration.initializer.end,
					);
			}
		preludeParts.push(source.slice(statement.getStart(file), statement.end));
	}

	return {
		sha256: createHash("sha256").update(source).digest("hex"),
		imports,
		preludeSource: preludeParts.join("\n"),
		preludeNames,
		preludeInitializers,
		/** In its own block, so the body's hoisted names may shadow the prelude's parameters. */
		bodySource: `{\n${emitStatements(body)}\n}`,
	};
}

export const loadSmoke = (): CompiledSmoke =>
	compileSmoke(readFileSync(smokePath, "utf8"));

export type CheckRun = {
	id: string;
	name: string;
	line: number;
	pass: boolean;
	info: string;
	/** The selectors the adapter resolved for this check (UI runs only). */
	selectors: string[];
};
export type StepError = { start: number; end: number; message: string };
export type BodyRun = { checks: CheckRun[]; errors: StepError[] };

export const slugify = (name: string): string =>
	name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

type AsyncFunctionConstructor = new (
	...args: string[]
) => (...values: unknown[]) => Promise<unknown>;
const AsyncFunction = Object.getPrototypeOf(async () => undefined)
	.constructor as AsyncFunctionConstructor;

const stepMilliseconds = 10_000;
const loopMilliseconds = 600_000;
const describeError = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** Runs the rewritten body over `environment` (one value per prelude name, plus `ok`). `settle` runs before every
 * step; `takeSelectors` returns and clears the selectors resolved since the last check. */
export async function runBody(
	compiled: CompiledSmoke,
	environment: Record<string, unknown>,
	hooks: {
		settle: () => Promise<void>;
		takeSelectors?: () => string[];
	},
): Promise<BodyRun> {
	const checks: CheckRun[] = [];
	const errors: StepError[] = [];
	const seen = new Map<string, number>();
	const stack: number[] = [];
	const record = (
		site: number,
		name: unknown,
		condition: unknown,
		info: unknown = "",
	): void => {
		const label = String(name);
		const slug = slugify(label);
		const occurrence = (seen.get(slug) ?? 0) + 1;
		seen.set(slug, occurrence);
		checks.push({
			id: `${slug}.${occurrence}`,
			name: label,
			line: stack.at(-1) ?? site,
			pass: Boolean(condition),
			info: condition ? "" : String(info ?? "").slice(0, 300),
			selectors: hooks.takeSelectors?.() ?? [],
		});
	};
	const runStep = async (
		start: number,
		end: number,
		action: () => Promise<void>,
		holdsSteps = false,
	): Promise<void> => {
		const budget = holdsSteps ? loopMilliseconds : stepMilliseconds;
		await hooks.settle();
		/** A check's selectors are those its own step resolved. */
		hooks.takeSelectors?.();
		stack.push(start);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				action(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`step timed out after ${budget} ms`)),
						budget,
					);
				}),
			]);
		} catch (error) {
			errors.push({ start, end, message: describeError(error) });
		} finally {
			clearTimeout(timer);
			stack.pop();
		}
	};
	const names = compiled.preludeNames.filter(
		(name) => !["ok", "__ok", "__run", "__after"].includes(name),
	);
	const ok = (name: unknown, condition: unknown, info?: unknown): void =>
		record(0, name, condition, info);
	/** The wait after an action: its value once the page has rendered it. */
	const after = async (value: unknown): Promise<unknown> => {
		const result = await value;
		await hooks.settle();
		return result;
	};
	const run = new AsyncFunction(
		"__ok",
		"__run",
		"__after",
		"ok",
		...names,
		compiled.bodySource,
	);
	await run(
		record,
		runStep,
		after,
		ok,
		...names.map((name) => environment[name]),
	);
	return { checks, errors };
}

/** Runs the prelude as written against the mockup and returns its names: the sync's environment. */
export async function mockupEnvironment(
	compiled: CompiledSmoke,
	htmlPath: string = mockupPath,
): Promise<Record<string, unknown>> {
	const locals: string[] = [];
	const values: unknown[] = [];
	for (const { specifier, bindings } of compiled.imports) {
		const module = (await import(specifier)) as Record<string, unknown>;
		for (const { imported, local } of bindings) {
			locals.push(local);
			values.push(module[imported]);
		}
	}
	const process = { argv: ["bun", smokePath, htmlPath], exit: () => undefined };
	const prelude = new AsyncFunction(
		...locals,
		"process",
		`${compiled.preludeSource}\nreturn {${compiled.preludeNames.join(",")}};`,
	);
	return (await prelude(...values, process)) as Record<string, unknown>;
}

export type Status = "pass" | "fail" | "pending-slice" | "na";
export type TableEntry = {
	name: string;
	/** First line of the smoke.mjs statement that runs the check. */
	line: number;
	slice: Slice;
	status: Status;
	/** Why: required for `na`; for `fail`, what the last recorded UI run saw. */
	reason?: string;
	/** The UI selectors the adapter resolved for the check in the last recorded UI run. */
	ui?: string;
	/** A person's diagnosis of a fail or a pending check; neither the sync nor --record touches it. */
	note?: string;
	/** Set by the sync when the current smoke.mjs no longer has the check. */
	removed?: true;
};
export type Table = {
	$comment: string;
	smoke: { path: string; sha256: string; runtimeChecks: number };
	sliceOrder: string[];
	checks: Record<string, TableEntry>;
};

export const tableComment =
	"Parity table (protocol v9 addendum §3): every runtime check of plans/ledger-ui/design/smoke.mjs, keyed <slug of the check name>.<occurrence>. slice: the slice that owns it (by the tab or feature it exercises). status: pass | fail (owned by a built slice and failing in the last recorded UI run; gate R stays red until it passes) | pending-slice (its slice is not built yet) | na (cannot apply to the UI; reason says why). line: first line of the smoke.mjs statement that runs it. ui: the UI selectors the adapter resolved for it. note: a person's diagnosis, kept by every tool. Regenerate ids with plans/ledger-ui/loop/tools/parity-sync.ts; record UI statuses with bun test/parity/run.ts --slice S<k> --record.";

export const readTable = (): Table =>
	JSON.parse(readFileSync(tablePath, "utf8")) as Table;
/** Written as Biome formats it (the short slice list on one line), so a regenerated table is lint-clean. */
export const writeTable = (table: Table): void =>
	writeFileSync(
		tablePath,
		`${JSON.stringify({ ...table, $comment: tableComment }, null, "\t").replace(
			/"sliceOrder": \[[^\]]*\]/,
			`"sliceOrder": ${JSON.stringify(table.sliceOrder).replace(/,/g, ", ")}`,
		)}\n`,
	);
