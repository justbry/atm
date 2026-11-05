#!/usr/bin/env bun
import { program } from "./cli.js";

// A reader that closes stdout early (`atm report ... | head`) is not an error of the run: without this handler Bun
// prints the EPIPE stack trace and exits 1, which `atm ship` means as a conflict.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
	if (error.code === "EPIPE") return;
	process.stderr.write(`atm: cannot write to stdout: ${error.message}\n`);
	process.exitCode = 2;
});

await program.parseAsync(process.argv);
