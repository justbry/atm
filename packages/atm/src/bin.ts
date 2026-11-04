#!/usr/bin/env bun
import { program } from "./cli.js";

await program.parseAsync(process.argv);
