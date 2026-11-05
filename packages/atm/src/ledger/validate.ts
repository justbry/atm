import {
	Ajv2020,
	type ErrorObject,
	type ValidateFunction,
} from "ajv/dist/2020.js";
import type { AtmEvent, AtmValidation, AtmValidationError } from "../types.js";
import { ulidTime } from "./ids.js";
import { envelopeSchema, payloadSchemas } from "./schemas.js";
import { decimalToUnits, localDate } from "./util.js";

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

let compiled: {
	envelope: ValidateFunction;
	payloads: Map<string, ValidateFunction>;
} | null = null;

const compile = () => {
	if (compiled) return compiled;
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	ajv.addFormat(
		"date-time",
		(s) => DATE_TIME.test(s) && !Number.isNaN(Date.parse(s)),
	);
	ajv.addFormat(
		"date",
		(s) =>
			DATE.test(s) &&
			!Number.isNaN(Date.parse(`${s}T00:00:00Z`)) &&
			new Date(`${s}T00:00:00Z`).toISOString().startsWith(s),
	);
	ajv.addFormat("decimal", /^-?\d+(\.\d+)?$/);
	compiled = {
		envelope: ajv.compile(envelopeSchema),
		payloads: new Map(
			Object.entries(payloadSchemas).map(([t, s]) => [t, ajv.compile(s)]),
		),
	};
	return compiled;
};

const fromAjv = (
	prefix: string,
	errors: ErrorObject[] | null | undefined,
): AtmValidationError[] =>
	(errors ?? []).map((e) => ({
		path: `${prefix}${e.instancePath}`,
		message: `${e.message ?? "invalid"}${e.params && "additionalProperty" in e.params ? ` (${String(e.params.additionalProperty)})` : ""}`,
	}));

const PLACES = (commodity: string) => (commodity === "USD" ? 2 : 0);

/**
 * The share events carry their amount twice, in the payload (cents) and as the posting to this account (dollars): the
 * statement and the books must not read two different numbers, so the two must agree.
 */
const SHARE_LIABILITY = "liabilities:b4uni";
const SHARE_PAYLOAD_AMOUNT: Readonly<Record<string, string>> = {
	"share.accrued": "share",
	"share.reversed": "reversed",
	"share.settled": "amount",
};
const USD_PLACES = 2;

/**
 * An event against its schemas (the envelope, then the payload schema of its `event_type`) and the rules a
 * schema cannot say: postings are none or at least two and sum to zero per commodity, USD has two places and
 * credits none, the id's time is the event time, `date` is the event time in `tz`.
 */
export const validateEvent = (event: unknown): AtmValidation => {
	const { envelope, payloads } = compile();
	const errors: AtmValidationError[] = [];
	if (!envelope(event)) errors.push(...fromAjv("", envelope.errors));
	const e = event as Partial<AtmEvent>;
	if (typeof e === "object" && e !== null && typeof e.event_type === "string") {
		const check = payloads.get(e.event_type);
		if (
			check &&
			typeof e.payload === "object" &&
			e.payload !== null &&
			!check(e.payload)
		) {
			errors.push(...fromAjv("/payload", check.errors));
		}
	}
	if (errors.length === 0) {
		const ev = event as AtmEvent;
		if (ev.postings.length === 1)
			errors.push({
				path: "/postings",
				message: "postings are none or at least two",
			});
		const sums = new Map<string, bigint>();
		ev.postings.forEach((p, i) => {
			try {
				const places = PLACES(p.commodity);
				const frac = p.amount.split(".")[1] ?? "";
				if (frac.length !== places) {
					errors.push({
						path: `/postings/${i}/amount`,
						message: `${p.commodity} has ${places} decimal places`,
					});
				}
				sums.set(
					p.commodity,
					(sums.get(p.commodity) ?? 0n) + decimalToUnits(p.amount, places),
				);
			} catch (err) {
				errors.push({
					path: `/postings/${i}/amount`,
					message: (err as Error).message,
				});
			}
		});
		for (const [commodity, sum] of sums) {
			if (sum !== 0n)
				errors.push({
					path: "/postings",
					message: `${commodity} postings sum to ${sum}, not zero`,
				});
		}
		const shareField = SHARE_PAYLOAD_AMOUNT[ev.event_type];
		if (shareField && errors.length === 0 && ev.postings.length > 0) {
			let posted = 0n;
			for (const p of ev.postings)
				if (p.account === SHARE_LIABILITY)
					posted += decimalToUnits(p.amount, USD_PLACES);
			const cents = ev.payload[shareField];
			if (posted < 0n) posted = -posted;
			if (typeof cents !== "number" || BigInt(cents) !== posted)
				errors.push({
					path: `/payload/${shareField}`,
					message: `${shareField} ${String(cents)} differs from the ${SHARE_LIABILITY} posting of ${posted} cents`,
				});
		}
		if (ulidTime(ev.id) !== Date.parse(ev.event_time)) {
			errors.push({ path: "/id", message: "the id's time is not event_time" });
		}
		if (ev.tz && ev.date !== localDate(Date.parse(ev.event_time), ev.tz)) {
			errors.push({
				path: "/date",
				message: `date is not event_time in ${ev.tz}`,
			});
		}
	}
	return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
};
