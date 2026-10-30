#!/usr/bin/env node
import { run } from './cli';

process.exitCode = await run();
