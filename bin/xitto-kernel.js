#!/usr/bin/env node
import { main } from '../src/app/main.js';
main().catch((err) => { console.error('\x1b[31m' + (err?.stack || err?.message || err) + '\x1b[0m'); process.exit(1); });
