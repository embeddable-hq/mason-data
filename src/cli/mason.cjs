#!/usr/bin/env node
/**
 * THE `mason` COMMAND'S ENTRY (the published `bin`, the image's `mason`, the run src/cli/background.ts starts): sets the
 * pool's size, then loads the command. CommonJS because on Node 22, which the package allows, loading an ES module
 * reads its files through libuv's pool, so the pool has started with four threads before an ES entry's first line
 * runs: measured on 22.13, where a CommonJS entry alone got 16 threads of 16. Node 24 and 26 read those files
 * synchronously, which is why main.ts's first import is enough in a checkout. Nothing here may use the pool.
 */
"use strict";
require("./pool-size.cjs");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// the .ts in a checkout and the image, the .js in the package (src/lib/runnable.ts, which this file cannot import yet)
const ts = path.join(__dirname, "main.ts");
import(pathToFileURL(fs.existsSync(ts) ? ts : path.join(__dirname, "main.js")).href);
