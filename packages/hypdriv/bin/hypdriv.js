#!/usr/bin/env node
// The `hypdriv` command, provided by @hypdriv/cli.
import { main } from '@hypdriv/cli';

process.exitCode = await main(process.argv.slice(2));
