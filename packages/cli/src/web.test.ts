import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveCliOptions } from './config';
import { ocrErrorPayload } from './errors';
import {
  assertWebOutputAvailable,
  readableWebText,
  renderWebResult,
  resolveWebUrls,
  runWebJob,
} from './web';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-web-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('CLI Web OCR', () => {
  it('merges arguments and URL files, ignores comments, and deduplicates', async () => {
    await writeFile(path.join(directory, 'urls.txt'), [
      '# reports',
      'https://example.com/report',
      'https://example.org/data.pdf',
      '',
    ].join('\n'));
    const urls = await resolveWebUrls(['https://example.com/report'], 'urls.txt', directory);
    expect(urls).toEqual(['https://example.com/report', 'https://example.org/data.pdf']);
  });

  it('names an unreadable --file list instead of leaking a raw errno', async () => {
    let thrown: unknown;
    try {
      await resolveWebUrls([], 'urls.txt', directory);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe('URL list file not found: urls.txt');
    expect((thrown as Error).message).not.toContain('ENOENT');
    expect((thrown as Error).message).not.toContain(directory);
    expect(ocrErrorPayload(thrown, 2)).toMatchObject({
      code: 'INPUT_NOT_FOUND',
      category: 'input',
      retryable: false,
    });
    await expect(resolveWebUrls([], '.', directory)).rejects.toThrow('URL list path is not a file: .');
  });

  it('rejects unsafe URLs and request groups above the API limit', async () => {
    await expect(resolveWebUrls(['http://localhost/private'], undefined, directory)).rejects.toThrow('Unsupported or unsafe');
    const tooMany = Array.from({ length: 21 }, (_, index) => `https://example.com/${index}`);
    await expect(resolveWebUrls(tooMany, undefined, directory)).rejects.toThrow('at most 20');
  });

  it('renders individual, combined, comparison, and JSON output', () => {
    const individual = {
      results: [{ url: 'https://example.com', title: 'Example', type: 'webpage' as const, content: 'Hello' }],
    };
    expect(renderWebResult(individual, 'individual', 'markdown')).toContain('# Example');
    expect(renderWebResult({ combinedContent: '# Combined' }, 'combined', 'markdown')).toBe('# Combined\n');
    expect(renderWebResult({ comparisonAnalysis: '# Comparison' }, 'comparison', 'markdown')).toBe('# Comparison\n');
    expect(renderWebResult(individual, 'individual', 'json')).toContain('"results"');
    expect(() => renderWebResult({}, 'individual', 'markdown')).toThrow('no results');
  });

  it('extracts structured HTML text and decodes named and numeric entities', async () => {
    const html = [
      '<html><body><main>',
      '<h1>Invoice&nbsp;42</h1>',
      '<p>Seller: ACME &amp; Co<br>Total: &euro;10 &#x2B; tax</p>',
      '<ul><li>First item</li><li>Second item</li></ul>',
      '<script>doNotInclude()</script>',
      '</main></body></html>',
    ].join('');
    const text = await readableWebText(new TextEncoder().encode(html), 'text/html');

    expect(text).toContain('INVOICE 42');
    expect(text).toContain('Seller: ACME & Co');
    expect(text).toContain('Total: €10 + tax');
    expect(text).toContain('First item');
    expect(text).not.toContain('doNotInclude');
  });


  it('converts deeply nested markup instead of overflowing the stack', async () => {
    const html = `${'<div>'.repeat(5000)}x${'</div>'.repeat(5000)}`;
    await expect(readableWebText(new TextEncoder().encode(html), 'text/html')).resolves.toBe('x');
  });

  it('bounds the cost of converting a hostile, deeply nested page', async () => {
    // About 1 MB of nesting: quadratic to parse, so it either converts or is
    // refused within the budget, and the event loop keeps running meanwhile.
    const depth = 100_000;
    const html = `${'<div>'.repeat(depth)}x${'</div>'.repeat(depth)}`;
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 20);
    const started = Date.now();
    try {
      const outcome = await readableWebText(new TextEncoder().encode(html), 'text/html', undefined, 1_500)
        .then(() => 'converted', (error: unknown) => error);
      expect(Date.now() - started).toBeLessThan(4_000);
      if (outcome !== 'converted') {
        expect(outcome).toMatchObject({ code: 'INPUT_INVALID', category: 'input', retryable: false });
      }
      expect(ticks).toBeGreaterThan(5);
    } finally {
      clearInterval(ticker);
    }
  });

  it('stops a conversion promptly when the attempt is cancelled', async () => {
    const depth = 100_000;
    const html = `${'<div>'.repeat(depth)}x${'</div>'.repeat(depth)}`;
    const controller = new AbortController();
    const started = Date.now();
    const pending = readableWebText(new TextEncoder().encode(html), 'text/html', controller.signal);
    setTimeout(() => controller.abort(new Error('attempt cancelled')), 100);
    await expect(pending).rejects.toThrow('attempt cancelled');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('extracts the text of an SVG document instead of skipping its root', async () => {
    const svg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><title>Quarterly Revenue</title>'
      + '<text x="1" y="2">Revenue Q3: <tspan>$1.2M</tspan></text></svg>';
    for (const contentType of ['image/svg+xml', 'application/xml']) {
      const text = await readableWebText(new TextEncoder().encode(svg), contentType);
      expect(text).toContain('Quarterly Revenue');
      expect(text).toContain('Revenue Q3: $1.2M');
    }
    // Inline SVG inside a page is still decoration.
    await expect(readableWebText(new TextEncoder().encode('<p>Hello</p><svg><text>icon</text></svg><p>world</p>'), 'text/html'))
      .resolves.toBe('Hello\n\nworld');
  });

  it('preflights an existing destination before Web OCR can spend API tokens', async () => {
    const target = path.join(directory, 'result.md');
    await writeFile(target, 'existing');
    await expect(assertWebOutputAvailable('result.md', directory, false)).rejects.toThrow(
      `Output already exists: ${target} (use --overwrite)`,
    );
    await expect(assertWebOutputAvailable('result.md', directory, true)).resolves.toBe(target);
    await expect(assertWebOutputAvailable('new.md', directory, false)).resolves.toBe(
      path.join(directory, 'new.md'),
    );
  });

  it('plans an extensionless --output path as the exact Web OCR file', async () => {
    const output = path.join(directory, 'result');
    const options = resolveCliOptions({
      dryRun: true,
      output,
      outputPathKind: 'file',
    }, {}, directory);

    const execution = await runWebJob(
      ['https://example.com'],
      'individual',
      options,
      { runId: 'web-output-file', abortController: new AbortController() },
    );

    expect(execution.result.documents[0]?.plannedArtifacts).toEqual([{
      path: output,
      kind: 'markdown',
      mediaType: 'text/markdown',
    }]);
  });
});
