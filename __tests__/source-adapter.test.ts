import { describe, it, expect, afterEach } from 'vitest';
import {
  registerAdapter,
  resolveAdapter,
  getAdapterRegistrations,
  clearAdapterRegistry,
  IdentityAdapter,
  adaptFile,
  type SourceAdapter,
} from '../src/extraction/source-adapter';

const makeAdapter = (name: string, ext: string): SourceAdapter => ({
  name,
  canHandle: (fp) => fp.endsWith(ext),
  adapt: (_fp, content) => ({
    text: `[${name}] ${typeof content === 'string' ? content : content.toString('utf-8')}`,
    metadata: { adapter: name },
  }),
});

describe('source-adapter registry (mechanism)', () => {
  let saved: readonly SourceAdapter[];

  afterEach(() => {
    clearAdapterRegistry();
    for (const a of saved) registerAdapter(a);
  });
  saved = getAdapterRegistrations().slice();

  it('resolves first-match-wins in registration order', () => {
    clearAdapterRegistry();
    registerAdapter(makeAdapter('a', '.md'));
    registerAdapter(makeAdapter('b', '.md'));
    expect(resolveAdapter('README.md')?.name).toBe('a');
  });

  it('returns undefined when nothing matches', () => {
    clearAdapterRegistry();
    expect(resolveAdapter('main.ts')).toBeUndefined();
  });

  it('re-registering same name replaces in place (idempotent)', () => {
    clearAdapterRegistry();
    registerAdapter(makeAdapter('x', '.pdf'));
    registerAdapter(makeAdapter('y', '.docx'));
    const before = getAdapterRegistrations().length;
    registerAdapter(makeAdapter('x', '.txt')); // replace x in place
    expect(getAdapterRegistrations().length).toBe(before);
    expect(resolveAdapter('note.txt')?.name).toBe('x');
  });
});

describe('IdentityAdapter', () => {
  it('passes string content through unchanged', () => {
    const result = IdentityAdapter.adapt('foo.ts', 'hello world');
    expect(result.text).toBe('hello world');
    expect(result.metadata).toEqual({});
  });

  it('converts Buffer to utf-8 string', () => {
    const buf = Buffer.from('café', 'utf-8');
    const result = IdentityAdapter.adapt('foo.ts', buf);
    expect(result.text).toBe('café');
  });

  it('canHandle returns true for any path', () => {
    expect(IdentityAdapter.canHandle('anything.pdf')).toBe(true);
  });
});

describe('adaptFile', () => {
  let saved: readonly SourceAdapter[];

  afterEach(() => {
    clearAdapterRegistry();
    for (const a of saved) registerAdapter(a);
  });
  saved = getAdapterRegistrations().slice();

  it('uses registered adapter when available', async () => {
    clearAdapterRegistry();
    registerAdapter(makeAdapter('md', '.md'));
    const result = await adaptFile('README.md', 'hello');
    expect(result.text).toBe('[md] hello');
    expect(result.metadata).toEqual({ adapter: 'md' });
  });

  it('falls back to IdentityAdapter when no adapter matches', async () => {
    clearAdapterRegistry();
    const result = await adaptFile('main.ts', 'const x = 1;');
    expect(result.text).toBe('const x = 1;');
    expect(result.metadata).toEqual({});
  });
});
