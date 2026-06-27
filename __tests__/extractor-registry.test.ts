import { describe, it, expect, afterEach } from 'vitest';
import {
  registerExtractor,
  resolveExtractor,
  getExtractorRegistrations,
  clearExtractorRegistry,
  type StandaloneExtractor,
} from '../src/extraction/extractor-registry';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

const emptyExtractor = (): StandaloneExtractor => ({
  extract: () => ({ nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 }),
});

describe('extractor-registry (mechanism)', () => {
  // The production registrations live as module side-effects in tree-sitter.ts.
  // These tests mutate the shared registry, so snapshot + restore around each.
  let saved: ReturnType<typeof getExtractorRegistrations>;
  afterEach(() => {
    clearExtractorRegistry();
    for (const r of saved) registerExtractor(r);
  });
  saved = getExtractorRegistrations().slice();

  it('resolves first-match-wins in registration order', () => {
    clearExtractorRegistry();
    registerExtractor({ name: 'a', match: ({ language }) => language === 'typescript', create: emptyExtractor });
    registerExtractor({ name: 'b', match: ({ language }) => language === 'typescript', create: emptyExtractor });
    expect(resolveExtractor('typescript', '.ts')?.name).toBe('a');
  });

  it('matches on file extension', () => {
    clearExtractorRegistry();
    registerExtractor({ name: 'form', match: ({ language, fileExtension }) => language === 'pascal' && fileExtension === '.dfm', create: emptyExtractor });
    expect(resolveExtractor('pascal', '.dfm')?.name).toBe('form');
    expect(resolveExtractor('pascal', '.pas')).toBeUndefined();
  });

  it('re-registering a name replaces in place (idempotent, no duplicate)', () => {
    clearExtractorRegistry();
    registerExtractor({ name: 'x', match: () => false, create: emptyExtractor });
    registerExtractor({ name: 'y', match: () => false, create: emptyExtractor });
    const before = getExtractorRegistrations().length;
    registerExtractor({ name: 'x', match: ({ language }) => language === 'go', create: emptyExtractor });
    expect(getExtractorRegistrations().length).toBe(before);
    expect(resolveExtractor('go', '.go')?.name).toBe('x');
  });

  it('returns undefined when nothing matches (→ tree-sitter fallback)', () => {
    clearExtractorRegistry();
    expect(resolveExtractor('rust', '.rs')).toBeUndefined();
  });
});

describe('extractFromSource dispatch (integration, default registrations)', () => {
  it('routes .vue to the Vue extractor (component node)', () => {
    const result = extractFromSource('Widget.vue', '<template><div/></template>\n<script>export default {}</script>');
    expect(result.nodes.some((n) => n.kind === 'component' && n.name === 'Widget')).toBe(true);
  });

  it('routes a file-level-only language (yaml) to an empty result', () => {
    const result = extractFromSource('config.yml', 'a:\n  b: 1\n');
    expect(result.nodes).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('falls back to TreeSitterExtractor for an ordinary source file', async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['typescript']);
    const result = extractFromSource('m.ts', 'export function hello() { return 1; }');
    expect(result.nodes.some((n) => n.name === 'hello')).toBe(true);
  });
});
