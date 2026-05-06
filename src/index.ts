#!/usr/bin/env node
import chalk from "chalk";
import { App } from "./core/App.js";

const args = process.argv.slice(2);
const fastMode = args.includes("-f") || args.includes("--fast");

new App(fastMode).run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red(`\n✖ ${message}\n`));
  process.exit(1);
});