/**
 * The ledger model (`model/ledger.v1.json`, checked against `schema/model.v1.json`): the entities of a school's books,
 * how they join, the dimensions a KPI is split by and what each KPI means. A measure of `source: kpiSpec` is the KPI of
 * the same id in `kpis/school.v1.json` and restates nothing the spec says; `resolve.ts` resolves the two together. Not
 * Worker code (it compiles a schema with Ajv): the Worker resolves the committed JSON with `resolve.ts` alone
 * (`src/ledger/kpi-catalog.ts`).
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import modelJson from "../../model/ledger.v1.json";
import modelSchema from "../../schema/model.v1.json";
import type { KpiSpec } from "../scenario/kpi-evaluate.js";
import { SCHOOL_KPIS } from "../scenario/kpis.js";
import {
	type LedgerModel,
	LedgerModelError,
	type ResolvedModel,
	resolveLedgerModel,
} from "./resolve.js";

/** ` (measure <id>)` for a schema error under `/measures/<index>`, so a refusal names the term, not only its place. */
const measureNamed = (raw: unknown, path: string): string => {
	const index = /^\/measures\/([0-9]+)/.exec(path)?.[1];
	if (index === undefined) return "";
	const measures = (raw as { measures?: Array<{ id?: unknown }> }).measures;
	const id = measures?.[Number(index)]?.id;
	return typeof id === "string" ? ` (measure ${id})` : "";
};

let validator: ReturnType<Ajv2020["compile"]> | null = null;

/**
 * The model checked against its schema, then resolved against the KPI spec (`resolveLedgerModel`). Throws
 * `LedgerModelError` with every schema error, else with every reference problem the resolution finds.
 */
export const parseLedgerModel = (
	raw: unknown,
	spec: KpiSpec = SCHOOL_KPIS,
): ResolvedModel => {
	if (!validator)
		validator = new Ajv2020({ allErrors: true, strict: false }).compile(
			modelSchema,
		);
	if (!validator(raw))
		throw new LedgerModelError(
			`model does not match schema/model.v1.json: ${(validator.errors ?? [])
				.map(
					(error) =>
						`${error.instancePath || "/"}${measureNamed(raw, error.instancePath)} ${error.message}`,
				)
				.join("; ")}`,
		);
	return resolveLedgerModel(raw as LedgerModel, spec);
};

/** The committed model, resolved against the committed KPI spec. */
export const LEDGER_MODEL = parseLedgerModel(modelJson);
