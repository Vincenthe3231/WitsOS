#!/usr/bin/env node
// Probe witsos_trace against an index using the built dist.
// Usage: node probe-trace.mjs <repo-with-.witsos> <from> <to>
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [, , repo, from, to] = process.argv;
if (!repo || !from || !to) { console.error('usage: probe-trace.mjs <repo> <from> <to>'); process.exit(1); }

const load = async (rel) => import(pathToFileURL(resolve(rel)).href);
const idx = await load('dist/index.js');
const tools = await load('dist/mcp/tools.js');
const WitsOS = idx.default?.default ?? idx.default ?? idx.WitsOS;
const ToolHandler = tools.ToolHandler ?? tools.default?.ToolHandler;

const cg = WitsOS.openSync(repo);
const h = new ToolHandler(cg);
const res = await h.execute('witsos_trace', { from, to });
console.log(res.content?.[0]?.text ?? '(no text)');
try { cg.close?.(); } catch {}
