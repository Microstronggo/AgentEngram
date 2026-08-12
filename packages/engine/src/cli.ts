#!/usr/bin/env node
import { runAdminCli } from "./admin-cli.js";

process.exitCode = await runAdminCli(process.argv.slice(2));
