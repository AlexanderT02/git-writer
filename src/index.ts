#!/usr/bin/env node
import chalk from "chalk";
import { App } from "./core/App.js";

new App().run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red(`\n✖ ${message}\n`));
  process.exit(1);
});
