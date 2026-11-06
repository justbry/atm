/**
 * Where `atm inputs ship` puts the objects: a folder (`--root`) or an R2 bucket (`--r2-bucket`, `--r2-endpoint`,
 * `--r2-prefix`). Precedence, highest first: the flags; the environment variables for the same non-secret values
 * (`ATM_R2_ENDPOINT`, `ATM_R2_BUCKET`, `ATM_R2_PREFIX`), used only when `--root` is not given; nothing, which is an error. The
 * credentials come from the environment only (`ATM_R2_ACCESS_KEY_ID`, `ATM_R2_SECRET_ACCESS_KEY`, optional
 * `ATM_R2_SESSION_TOKEN`), never from a flag: a flag shows in the process list. Pure: it reads nothing but its arguments.
 */
import type { R2StoreOptions } from "../types.js";

export type InputsDestinationFlags = {
	root?: string;
	r2Bucket?: string;
	r2Endpoint?: string;
	r2Prefix?: string;
};

export type InputsDestination =
	| { kind: "folder"; root: string }
	| { kind: "r2"; options: R2StoreOptions };

/** A refusal whose message is already the one line for the operator. */
export class InputsDestinationError extends Error {}

export const R2_ENV = {
	endpoint: "ATM_R2_ENDPOINT",
	bucket: "ATM_R2_BUCKET",
	prefix: "ATM_R2_PREFIX",
	accessKeyId: "ATM_R2_ACCESS_KEY_ID",
	secretAccessKey: "ATM_R2_SECRET_ACCESS_KEY",
	sessionToken: "ATM_R2_SESSION_TOKEN",
} as const;

const HTTP_URL = /^https?:\/\/[^\s/]+/;

/** A value that is there: an empty string, as an unset variable is sometimes exported, is not. */
const present = (value: string | undefined): string | undefined =>
	value === undefined || value === "" ? undefined : value;

export const resolveInputsDestination = (
	flags: InputsDestinationFlags,
	env: Readonly<Record<string, string | undefined>>,
): InputsDestination => {
	const r2Flags = [flags.r2Bucket, flags.r2Endpoint, flags.r2Prefix].some(
		(value) => value !== undefined,
	);
	if (flags.root !== undefined) {
		if (r2Flags)
			throw new InputsDestinationError(
				"give --root, or --r2-bucket with --r2-endpoint, not both",
			);
		return { kind: "folder", root: flags.root };
	}
	const bucket = present(flags.r2Bucket) ?? present(env[R2_ENV.bucket]);
	if (bucket === undefined)
		throw new InputsDestinationError(
			`give --root <folder>, or --r2-bucket <name> with --r2-endpoint <url> (or ${R2_ENV.bucket} and ${R2_ENV.endpoint} in the environment)`,
		);
	const endpoint = present(flags.r2Endpoint) ?? present(env[R2_ENV.endpoint]);
	if (endpoint === undefined)
		throw new InputsDestinationError(
			`--r2-bucket needs --r2-endpoint <url> (or ${R2_ENV.endpoint} in the environment)`,
		);
	if (!HTTP_URL.test(endpoint))
		throw new InputsDestinationError(
			"--r2-endpoint must be an http:// or https:// URL",
		);
	const accessKeyId = present(env[R2_ENV.accessKeyId]);
	const secretAccessKey = present(env[R2_ENV.secretAccessKey]);
	const missing = [
		accessKeyId === undefined ? R2_ENV.accessKeyId : null,
		secretAccessKey === undefined ? R2_ENV.secretAccessKey : null,
	].filter((name) => name !== null);
	if (accessKeyId === undefined || secretAccessKey === undefined)
		throw new InputsDestinationError(
			`R2 credentials come from the environment only; set ${missing.join(" and ")} (there is no flag for them)`,
		);
	const prefix = present(flags.r2Prefix) ?? present(env[R2_ENV.prefix]);
	const sessionToken = present(env[R2_ENV.sessionToken]);
	return {
		kind: "r2",
		options: {
			endpoint,
			bucket,
			accessKeyId,
			secretAccessKey,
			...(prefix === undefined ? {} : { prefix }),
			...(sessionToken === undefined ? {} : { sessionToken }),
		},
	};
};
