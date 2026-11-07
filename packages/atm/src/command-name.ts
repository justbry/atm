import { basename, extname } from "node:path";

/** The name the Trifold engine's CLI goes by; `atm` is the same command under its earlier name. */
const DEFAULT_COMMAND_NAME = "tfd";
const LEGACY_COMMAND_NAME = "atm";

/**
 * The command a caller typed: `atm` when the script path (`process.argv[1]`) is `atm` or `atm.js`, `tfd` for anything else
 * (`tfd`, `bin` when run as `bun ./src/bin.ts`, `cli` or a test runner, no path at all).
 */
export const invokedCommandName = (
	argvPath: string | undefined,
): "atm" | "tfd" => {
	if (!argvPath) return DEFAULT_COMMAND_NAME;
	const name = basename(argvPath, extname(argvPath));
	return name === LEGACY_COMMAND_NAME
		? LEGACY_COMMAND_NAME
		: DEFAULT_COMMAND_NAME;
};

/** The name this process was invoked as, for the help text and the commands it prints for the caller to copy. */
export const commandName = invokedCommandName(process.argv[1]);
