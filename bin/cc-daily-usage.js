#!/usr/bin/env node
import { runCli } from "../dist/cli.js";

try {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
