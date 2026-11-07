#!/usr/bin/env bun
// The `atm` bin. It is its own file, named atm, because Bun reports a symlinked script (node_modules/.bin/atm,
// `bun link`) by its target's real path: pointed at bin.ts, `atm` would name itself tfd (see command-name.ts).
import "./bin.js";
