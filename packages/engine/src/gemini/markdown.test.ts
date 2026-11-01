import { describe, expect, it } from 'vitest';

import { coerceExtractionResult, EXTRACTED_CONTENT_RESPONSE_SCHEMA, joinPromptParts } from './extraction';
import {
  closesFence,
  markdownToSections,
  normalizeModelMarkdown,
  parseFenceOpener,
  sectionsToMarkdown,
  stripReasoningBlocks,
} from './markdown';
import { extractJsonPayload, parseJsonPayload } from './structured';
import { OcrError } from './types';

describe('simple Markdown mode preserves the model Markdown', () => {
  const raw = [
    '<think>internal reasoning</think>',
    '',
    'Preamble text.',
    '',
    '# Title',
    '',
    '## Part A',
    '',
    '### Detail A.1',
    '',
    '#### Note',
    '',
    'Deep text with hard break  ',
    'next line',
    '',
  ].join('\r\n');

  it('keeps heading levels, single blank lines, the H1, and hard breaks; drops CRLF and reasoning', () => {
    const result = coerceExtractionResult(raw, false);
    expect(result.markdown).toBe([
      'Preamble text.',
      '',
      '# Title',
      '',
      '## Part A',
      '',
      '### Detail A.1',
      '',
      '#### Note',
      '',
      'Deep text with hard break  ',
      'next line',
    ].join('\n'));
    expect(result.markdown).not.toMatch(/\r|think/);
  });

  it('indexes sections with their heading levels and no leading blank lines', () => {
    const result = coerceExtractionResult(raw, false);
    expect(result.title).toBeUndefined();
    expect(result.sections).toEqual([
      { content: ['Preamble text.'] },
      { heading: 'Title', level: 1, content: [] },
      { heading: 'Part A', level: 2, content: [] },
      { heading: 'Detail A.1', level: 3, content: [] },
      { heading: 'Note', level: 4, content: ['Deep text with hard break  ', 'next line'] },
    ]);
  });

  it('keeps a trailing reasoning block out of the artifact and rejects reasoning-only answers', () => {
    expect(coerceExtractionResult('# T\n\nbody\n<think>x</think>', false).markdown).toBe('# T\n\nbody');
    expect(() => coerceExtractionResult('<think>only thoughts</think>', false)).toThrow(/empty response/);
  });

  it('keeps indentation of a leading indented code block', () => {
    expect(normalizeModelMarkdown('\n\n    code line\n\ntext\n\n')).toBe('    code line\n\ntext');
  });
});

describe('section parser fences and code', () => {
  it('does not treat 4-space-indented "# x" as a heading', () => {
    const { sections } = markdownToSections('## Real\n\n    # not a heading\n');
    expect(sections).toEqual([{ heading: 'Real', level: 2, content: ['    # not a heading'] }]);
  });

  it('closes a fence only on a matching, at-least-as-long, info-less run', () => {
    const markdown = [
      '## Code',
      '````md',
      '```js',
      '# inside nested fence',
      '```',
      '# still inside the outer fence',
      '````',
      '## After',
      '~~~',
      '```',
      '# inside tilde fence',
      '~~~',
    ].join('\n');
    const { sections } = markdownToSections(markdown);
    expect(sections.map((section) => section.heading)).toEqual(['Code', 'After']);
    expect(sections[0].content).toContain('# still inside the outer fence');
    expect(sections[1].content).toContain('# inside tilde fence');
  });

  it('parses fence openers and closers per CommonMark', () => {
    const opener = parseFenceOpener('````json');
    expect(opener).toEqual({ char: '`', length: 4, info: 'json' });
    expect(closesFence('```', opener!)).toBe(false);
    expect(closesFence('`````', opener!)).toBe(true);
    expect(closesFence('```` json', opener!)).toBe(false);
    expect(closesFence('~~~~', opener!)).toBe(false);
    expect(parseFenceOpener('``` a`b')).toBeUndefined();
    expect(parseFenceOpener('    ```')).toBeUndefined();
  });

  it('recognises setext headings and ATX closing sequences, not "#1042" text', () => {
    const { title, sections } = markdownToSections('Main\n====\n\nSub\n---\n\n## Closed ##\n\n#1042 is an order number');
    expect(title).toBe('Main');
    expect(sections).toEqual([
      { heading: 'Sub', level: 2, content: [] },
      { heading: 'Closed', level: 2, content: ['#1042 is an order number'] },
    ]);
  });

  it('rebuilds Markdown from JSON sections at their recorded levels', () => {
    expect(sectionsToMarkdown({
      title: 'T',
      sections: [
        { heading: 'A', level: 3, content: ['', 'x', ''] },
        { heading: 'B', content: ['y'] },
        { content: ['z'] },
      ],
    })).toBe('# T\n\n### A\n\nx\n\n## B\n\ny\n\nz');
  });

  it('strips only whole leading/trailing reasoning blocks', () => {
    expect(stripReasoningBlocks('<think>a</think>\nbody <think>kept</think> end')).toBe('\nbody <think>kept</think> end');
  });
});

describe('shared tolerant JSON extraction', () => {
  it('accepts bare JSON, fenced JSON, and JSON surrounded by prose', () => {
    expect(parseJsonPayload('{"a":1}', 'X')).toEqual({ a: 1 });
    expect(parseJsonPayload('```json\n{"a":1}\n```', 'X')).toEqual({ a: 1 });
    expect(parseJsonPayload('Sure, here it is:\n{"a":1}\nLet me know!', 'X')).toEqual({ a: 1 });
    expect(parseJsonPayload('<think>{"draft":true}</think>{"a":1}', 'X')).toEqual({ a: 1 });
  });

  it('prefers the last parsing fenced json block', () => {
    expect(parseJsonPayload('Draft:\n```json\n{"a":1}\n```\nFinal:\n```json\n{"a":2}\n```', 'X')).toEqual({ a: 2 });
  });

  it('scans balanced braces with string awareness instead of first-{ to last-}', () => {
    const text = 'Ignore {this}. Result: {"note":"a } brace","n":{"m":1}} and {more} trailing}';
    expect(extractJsonPayload(text, 'X')).toBe('{"note":"a } brace","n":{"m":1}}');
  });

  it('does not return a nested object from a malformed outer object', () => {
    expect(() => parseJsonPayload('{"outer": {"inner": 1}, oops}', 'X')).toThrow(/X returned invalid JSON/);
  });

  it('does not return a nested object from an outer object that never closes', () => {
    const truncated = 'Answer: {"result": {"name": "a"}, "items": [1, 2';
    expect(extractJsonPayload(truncated, 'X')).not.toBe('{"name": "a"}');
    expect(() => parseJsonPayload(truncated, 'X')).toThrow(/X returned invalid JSON/);
    expect(() => parseJsonPayload('{"a": {"b": {"c": 1}}, "d": "x}', 'X')).toThrow(/X returned invalid JSON/);
  });

  it('still finds a complete top-level object after a closed prose brace', () => {
    expect(parseJsonPayload('Note {x} first. {"a":1}', 'X')).toEqual({ a: 1 });
  });

  it('types every failure as OUTPUT_INVALID', () => {
    for (const text of ['', 'no json here', '{"a":']) {
      let thrown: unknown;
      try {
        parseJsonPayload(text, 'X');
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(OcrError);
      expect(thrown).toMatchObject({ type: 'OUTPUT_INVALID' });
    }
  });
});

describe('simple JSON mode', () => {
  it('accepts fenced JSON like template and schema mode', () => {
    const result = coerceExtractionResult('```json\n{"sections":[{"heading":"H","level":3,"content":["x"]}]}\n```', true);
    expect(result.sections[0]).toEqual({ heading: 'H', level: 3, content: ['x'] });
  });

  it('distinguishes invalid JSON from a schema mismatch and names the path', () => {
    expect(() => coerceExtractionResult('{"sections": [', true)).toThrow(/was invalid JSON/);
    expect(() => coerceExtractionResult('{"sections":[{"content":["a", 5]}]}', true))
      .toThrow('did not match the OCR schema: sections[0].content[1] must be a string');
    expect(() => coerceExtractionResult('{"sections":[],"extra":1}', true))
      .toThrow('the response has unexpected property "extra"');
    expect(() => coerceExtractionResult('{"sections":[{"level":9,"content":[]}]}', true))
      .toThrow('sections[0].level must be an integer from 1 to 6');
  });

  it('treats JSON with no text as a failure, not an empty success', () => {
    expect(() => coerceExtractionResult('{"sections":[]}', true)).toThrow(/no text content/);
    expect(() => coerceExtractionResult('{"sections":[{"heading":" ","content":[""]}]}', true)).toThrow(/no text content/);
  });

  it('advertises the optional section level in the response schema', () => {
    const sections = (EXTRACTED_CONTENT_RESPONSE_SCHEMA.properties as Record<string, { items: { properties: Record<string, unknown> } }>).sections;
    expect(sections.items.properties.level).toEqual({ type: 'integer', minimum: 1, maximum: 6 });
  });
});

describe('prompt joining', () => {
  it('keeps instructions as separate, punctuated sentences', () => {
    expect(joinPromptParts(['Only the header', 'Detect and describe any images.', '  '])).toBe('Only the header.\nDetect and describe any images.');
  });
});
