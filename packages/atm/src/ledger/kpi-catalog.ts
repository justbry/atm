/**
 * The KPI catalog the document is built from and the derived KPIs the disclosure caps, computed at load from the ledger
 * model (`model/ledger.v1.json`) and the KPI spec (`kpis/school.v1.json`) by `src/model/resolve.ts`. Worker-safe: JSON
 * imports, resolved without Ajv (the shape is not validated at run time; `tests/model-generated.test.ts` holds this
 * catalog to the one resolved from the schema-checked model).
 */
import schoolSpec from "../../kpis/school.v1.json";
import modelJson from "../../model/ledger.v1.json";
import {
	derivedKpisOf,
	kpiCatalogOf,
	type LedgerModel,
	resolveLedgerModel,
} from "../model/resolve.js";
import type { KpiSpec } from "../scenario/kpi-evaluate.js";
import type { DetailStep } from "./kpi-disclosure.js";
import type { KpiFormat } from "./kpi-document-types.js";

/** How a figure adds up and is written: an amount of money, a count, or a rate (a fraction). */
export type KpiCatalogKind = "money" | "count" | "rate";
export type KpiCatalogEntry = {
	/** The mockup's label (its `KPI` table); a dimension's values are titled by the document. */
	title: string;
	kind: KpiCatalogKind;
	/** The KPI whose disclosure rule it follows: its own, or the model's `disclosure.ruleOf`. */
	ruleOf: string;
	/** The detail the figure needs (mockup bkFig `need`): the measure's own, else its dimension's. */
	need?: DetailStep;
	/** The measures it is worked out from: a rate's `[numerator, denominator]` in that order, a combine's terms. */
	inputs?: string[];
	/** How it is written when the audience does not round (`money0`: whole units always). */
	format: KpiFormat;
};
/** A derived KPI's inputs, and whether it is `capped` (in a more open class, it takes its inputs' rule: spec rule 3). */
export type DerivedKpi = { inputs: string[]; capped: boolean };

const resolved = resolveLedgerModel(
	modelJson as LedgerModel,
	schoolSpec as unknown as KpiSpec,
);
/** The document's KPIs in the document's order, keyed by id, or `id:*` for a measure split by a dimension. */
export const kpiCatalog = kpiCatalogOf(resolved);
/** The spec's ratio and combine KPIs, by id. */
export const derivedKpiCatalog = derivedKpisOf(resolved);
