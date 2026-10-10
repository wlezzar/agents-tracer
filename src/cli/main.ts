#!/usr/bin/env node
// The agents-tracer CLI: `agents-tracer --help` lists the commands.

import { homedir } from 'node:os';

import { run } from './run.js';

// console.log, unlike process.stdout.write, ignores a closed pipe, as in `agents-tracer list | head`.
process.exitCode = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  home: homedir(),
  env: process.env,
  out: (text) => {
    console.log(text);
  },
  err: (text) => {
    console.error(text);
  },
});
