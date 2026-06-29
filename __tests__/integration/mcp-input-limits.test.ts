/**
 * MCP tool input-size limits
 *
 * Regression coverage for the DoS vector: MCP clients can ship
 * unbounded payloads (`query`, `task`, `symbol`, `projectPath`,
 * `path`, `pattern`). Before the cap, a 100MB string would hit
 * the FTS5 layer and pin the server. These tests assert that the
 * tool layer rejects oversize inputs early.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import WitsOS from '../../src/index';
import { ToolHandler } from '../../src/mcp/tools';

describe('MCP input size limits', () => {
  let tempDir: string;
  let cg: WitsOS;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'witsos-mcp-limits-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'a.ts'),
      `export function alpha(): number { return 1; }\n`
    );
    cg = await WitsOS.init(tempDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('accepts a normal-sized query', async () => {
    const result = await handler.execute('witsos_search', { query: 'alpha' });
    expect(result.isError).toBeFalsy();
  });

  it('rejects an oversize query on witsos_search', async () => {
    const huge = 'a'.repeat(20_000);
    const result = await handler.execute('witsos_search', { query: huge });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/maximum length/i);
  });

  it('rejects an oversize query on witsos_explore', async () => {
    const huge = 'b'.repeat(50_000);
    const result = await handler.execute('witsos_explore', { query: huge });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/maximum length/i);
  });

  it('rejects an oversize symbol on witsos_callers', async () => {
    const huge = 'c'.repeat(15_000);
    const result = await handler.execute('witsos_callers', { symbol: huge });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/maximum length/i);
  });

  it('rejects an oversize symbol on witsos_impact', async () => {
    const huge = 'd'.repeat(11_000);
    const result = await handler.execute('witsos_impact', { symbol: huge });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/maximum length/i);
  });

  it('rejects an oversize projectPath', async () => {
    const hugePath = '/tmp/' + 'x'.repeat(5_000);
    const result = await handler.execute('witsos_search', {
      query: 'alpha',
      projectPath: hugePath,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/projectPath/);
  });

  it('rejects an oversize path filter on witsos_files', async () => {
    const hugePath = 'src/' + 'y'.repeat(5_000);
    const result = await handler.execute('witsos_files', { path: hugePath });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/path/);
  });

  it('rejects an oversize glob pattern on witsos_files', async () => {
    const hugePattern = '*'.repeat(5_000);
    const result = await handler.execute('witsos_files', { pattern: hugePattern });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/pattern/);
  });

  it('rejects a non-string projectPath', async () => {
    const result = await handler.execute('witsos_search', {
      query: 'alpha',
      projectPath: 12345 as unknown as string,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/projectPath/);
  });
});
