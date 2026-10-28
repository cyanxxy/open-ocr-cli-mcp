import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client', () => ({
  normalizeThinkingLevel: vi.fn(() => 'high'),
}));

vi.mock('./interactions', async () => {
  const actual = await vi.importActual<typeof import('./interactions')>('./interactions');
  return {
    ...actual,
    runModelInteraction: vi.fn(),
  };
});

import { dedupeRequestedUrls, extractTextFromUrls } from './operations';
import * as interactionsModule from './interactions';

const mockRunModelInteraction = vi.mocked(interactionsModule.runModelInteraction);

function urlContextResult(urls: string[]): { type: string; result: Array<{ status: string; url: string }> } {
  return {
    type: 'url_context_result',
    result: urls.map((url) => ({ status: 'success', url })),
  };
}

describe('extractTextFromUrls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns comparison analysis only when every URL retrieval is verified', async () => {
    mockRunModelInteraction.mockResolvedValueOnce({
      id: 'interaction-1',
      status: 'completed',
      steps: [
        {
          type: 'url_context_result',
          result: [
            { status: 'success', url: 'https://example.com' },
            { status: 'success', url: 'https://example.org' },
          ],
        },
        { type: 'model_output', content: [{ type: 'text', text: 'Verified comparison output' }] },
      ],
    });

    await expect(
      extractTextFromUrls(
        ['https://example.com', 'https://example.org'],
        'test-api-key',
        'comparison',
        'gemini-3.8-flash',
      ),
    ).resolves.toEqual({
      comparisonAnalysis: 'Verified comparison output',
    });
    expect(mockRunModelInteraction).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-3.8-flash',
    }));
  });

  it('fails closed when URL-context results are missing', async () => {
    mockRunModelInteraction.mockResolvedValueOnce({
      id: 'interaction-2',
      status: 'completed',
      steps: [
        { type: 'model_output', content: [{ type: 'text', text: 'This should not be trusted' }] },
      ],
    });

    await expect(
      extractTextFromUrls(
        ['https://example.com'],
        'test-api-key',
        'combined',
        'gemini-3.5-flash-lite',
      ),
    ).rejects.toThrow(
      'Grounded URL retrieval could not be verified for this response. Web OCR only returns content when URL-context retrieval reports success for every URL; it does not guess content.',
    );
  });

  it('rejects requires_action because URL context is a server-side tool', async () => {
    mockRunModelInteraction.mockResolvedValueOnce({
      id: 'interaction-requires-action',
      status: 'requires_action',
      steps: [
        urlContextResult(['https://example.com']),
        { type: 'model_output', content: [{ type: 'text', text: 'Not terminal' }] },
      ],
    });

    await expect(extractTextFromUrls(
      ['https://example.com'],
      'test-api-key',
      'combined',
      'gemini-3.8-flash',
    )).rejects.toThrow(/ended with status "requires_action"/i);
  });

  it('surfaces an error attached to a completed model_output step', async () => {
    mockRunModelInteraction.mockResolvedValueOnce({
      id: 'interaction-model-error',
      status: 'completed',
      steps: [
        urlContextResult(['https://example.com']),
        { type: 'model_output', content: [], error: { code: 13, message: 'generation failed' } },
      ],
    });

    await expect(extractTextFromUrls(
      ['https://example.com'],
      'test-api-key',
      'combined',
      'gemini-3.8-flash',
    )).rejects.toThrow(/model output failed: generation failed/i);
  });

  it('fails closed when any URL retrieval reports an error status', async () => {
    mockRunModelInteraction.mockResolvedValueOnce({
      id: 'interaction-3',
      status: 'completed',
      steps: [
        {
          type: 'url_context_result',
          result: [
            { status: 'success', url: 'https://example.com' },
            { status: 'error', url: 'https://example.org' },
          ],
        },
        { type: 'model_output', content: [{ type: 'text', text: 'Model guessed anyway' }] },
      ],
    });

    await expect(
      extractTextFromUrls(
        ['https://example.com', 'https://example.org'],
        'test-api-key',
        'comparison',
        'gemini-3.5-flash-lite',
      ),
    ).rejects.toThrow(
      'Grounded URL retrieval failed for https://example.org (error). Web OCR only returns content when URL-context retrieval reports success for every URL; it does not guess content.',
    );
  });

  it('fails closed when successful URL-context metadata belongs to another URL', async () => {
    mockRunModelInteraction.mockResolvedValueOnce({
      id: 'interaction-url-mismatch',
      status: 'completed',
      steps: [
        urlContextResult(['https://example.com', 'https://unexpected.example']),
        { type: 'model_output', content: [{ type: 'text', text: 'Unverified comparison' }] },
      ],
    });

    await expect(
      extractTextFromUrls(
        ['https://example.com', 'https://example.org'],
        'test-api-key',
        'comparison',
        'gemini-3.5-flash-lite',
      ),
    ).rejects.toThrow(
      'Grounded URL retrieval verified an unexpected URL (https://unexpected.example).',
    );
  });

  it('fails closed when URL-context metadata duplicates one requested URL', async () => {
    mockRunModelInteraction.mockResolvedValueOnce({
      id: 'interaction-url-duplicate',
      status: 'completed',
      steps: [
        urlContextResult(['https://example.com', 'https://example.com']),
        { type: 'model_output', content: [{ type: 'text', text: 'Unverified comparison' }] },
      ],
    });

    await expect(
      extractTextFromUrls(
        ['https://example.com', 'https://example.org'],
        'test-api-key',
        'comparison',
        'gemini-3.5-flash-lite',
      ),
    ).rejects.toThrow(
      'Grounded URL retrieval returned a duplicate result for https://example.com.',
    );
  });

  it('fails closed when individual mode does not return a complete per-URL payload', async () => {
    mockRunModelInteraction.mockResolvedValueOnce({
      id: 'interaction-4',
      status: 'completed',
      steps: [
        {
          type: 'url_context_result',
          result: [
            { status: 'success', url: 'https://example.com' },
            { status: 'success', url: 'https://example.org' },
          ],
        },
        {
          type: 'model_output',
          content: [{
            type: 'text',
            text: JSON.stringify({
              results: [
                {
                  url: 'https://example.com',
                  type: 'webpage',
                  content: 'Only one result',
                },
              ],
            }),
          }],
        },
      ],
    });

    await expect(
      extractTextFromUrls(
        ['https://example.com', 'https://example.org'],
        'test-api-key',
        'individual',
        'gemini-3.5-flash-lite',
      ),
    ).rejects.toThrow(
      'Grounded URL extraction did not return a complete result for every requested URL. Web OCR only returns content when URL-context retrieval reports success for every URL; it does not guess content.',
    );
  });

  it('pairs content with the correct URL even when the model reorders results', async () => {
    mockRunModelInteraction.mockResolvedValueOnce({
      id: 'interaction-5',
      status: 'completed',
      steps: [
        {
          type: 'url_context_result',
          result: [
            { status: 'success', url: 'https://example.com' },
            { status: 'success', url: 'https://example.org' },
          ],
        },
        {
          type: 'model_output',
          // Returned in the OPPOSITE order from the request, with a trailing
          // slash variation to exercise normalized matching. audit H-05: `www.`
          // is intentionally NOT collapsed, so the org entry keeps its
          // non-www host to remain matchable.
          content: [{
            type: 'text',
            text: JSON.stringify({
              results: [
                { url: 'https://example.org/', type: 'webpage', content: 'Org content' },
                { url: 'https://example.com', type: 'webpage', content: 'Com content' },
              ],
            }),
          }],
        },
      ],
    });

    const result = await extractTextFromUrls(
      ['https://example.com', 'https://example.org'],
      'test-api-key',
      'individual',
      'gemini-3.5-flash-lite',
    );

    const byUrl = Object.fromEntries((result.results ?? []).map((r) => [r.url, r.content]));
    expect(byUrl['https://example.com']).toBe('Com content');
    expect(byUrl['https://example.org']).toBe('Org content');
  });

  it('fails closed when individual mode returns a result for an unrequested URL', async () => {
    mockRunModelInteraction.mockResolvedValueOnce({
      id: 'interaction-6',
      status: 'completed',
      steps: [
        {
          type: 'url_context_result',
          result: [
            { status: 'success', url: 'https://example.com' },
            { status: 'success', url: 'https://example.org' },
          ],
        },
        {
          type: 'model_output',
          content: [{
            type: 'text',
            text: JSON.stringify({
              results: [
                { url: 'https://example.com', type: 'webpage', content: 'Com content' },
                { url: 'https://evil.example.net', type: 'webpage', content: 'Unexpected content' },
              ],
            }),
          }],
        },
      ],
    });

    await expect(
      extractTextFromUrls(
        ['https://example.com', 'https://example.org'],
        'test-api-key',
        'individual',
        'gemini-3.5-flash-lite',
      ),
    ).rejects.toThrow(
      'Grounded URL extraction returned a result for an unexpected URL (https://evil.example.net).',
    );
  });

  // audit H-05: http vs https must be treated as distinct identities.
  it('treats http and https for the same host as distinct URLs', async () => {
    mockRunModelInteraction.mockResolvedValueOnce({
      id: 'interaction-7',
      status: 'completed',
      steps: [
        urlContextResult(['http://example.com', 'https://example.com']),
        {
          type: 'model_output',
          content: [{
            type: 'text',
            text: JSON.stringify({
              results: [
                { url: 'http://example.com', type: 'webpage', content: 'Insecure content' },
                { url: 'https://example.com', type: 'webpage', content: 'Secure content' },
              ],
            }),
          }],
        },
      ],
    });

    const result = await extractTextFromUrls(
      ['http://example.com', 'https://example.com'],
      'test-api-key',
      'individual',
      'gemini-3.5-flash-lite',
    );

    const byUrl = Object.fromEntries((result.results ?? []).map((r) => [r.url, r.content]));
    expect(byUrl['http://example.com']).toBe('Insecure content');
    expect(byUrl['https://example.com']).toBe('Secure content');
  });

  // audit H-05: a www and a non-www host are different origins and must not be
  // matched against each other.
  it('does not match a www result against a non-www request', async () => {
    mockRunModelInteraction.mockResolvedValueOnce({
      id: 'interaction-8',
      status: 'completed',
      steps: [
        urlContextResult(['https://example.com']),
        {
          type: 'model_output',
          content: [{
            type: 'text',
            text: JSON.stringify({
              results: [
                { url: 'https://www.example.com', type: 'webpage', content: 'www content' },
              ],
            }),
          }],
        },
      ],
    });

    await expect(
      extractTextFromUrls(
        ['https://example.com'],
        'test-api-key',
        'individual',
        'gemini-3.5-flash-lite',
      ),
    ).rejects.toThrow(
      'Grounded URL extraction returned a result for an unexpected URL (https://www.example.com).',
    );
  });

  // audit H-05: the array-length check passes but a requested URL is never
  // matched (the model returned the first URL twice). The remaining.size===0
  // assertion must catch this.
  it('fails closed when a requested URL is never accounted for (duplicate model result)', async () => {
    mockRunModelInteraction.mockResolvedValueOnce({
      id: 'interaction-9',
      status: 'completed',
      steps: [
        urlContextResult(['https://example.com', 'https://example.org']),
        {
          type: 'model_output',
          content: [{
            type: 'text',
            text: JSON.stringify({
              results: [
                { url: 'https://example.com', type: 'webpage', content: 'First' },
                { url: 'https://example.com', type: 'webpage', content: 'Duplicate' },
              ],
            }),
          }],
        },
      ],
    });

    await expect(
      extractTextFromUrls(
        ['https://example.com', 'https://example.org'],
        'test-api-key',
        'individual',
        'gemini-3.5-flash-lite',
      ),
    ).rejects.toThrow(
      'Grounded URL extraction returned a result for an unexpected URL (https://example.com).',
    );
  });

  // audit W-05: the output budget scales with the URL count for individual mode.
  it('scales maxOutputTokens with the URL count in individual mode', async () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://example${i}.com`);
    mockRunModelInteraction.mockResolvedValueOnce({
      id: 'interaction-10',
      status: 'completed',
      steps: [
        urlContextResult(urls),
        {
          type: 'model_output',
          content: [{
            type: 'text',
            text: JSON.stringify({
              results: urls.map((url) => ({ url, type: 'webpage', content: `Content for ${url}` })),
            }),
          }],
        },
      ],
    });

    await extractTextFromUrls(urls, 'test-api-key', 'individual', 'gemini-3.5-flash-lite');

    const call = mockRunModelInteraction.mock.calls[0][0];
    // 10 URLs * 2048 = 20480 (> the old fixed 8192 budget). The generation
    // config maps maxOutputTokens onto the wire key `max_output_tokens`.
    expect(call.generationConfig?.max_output_tokens).toBe(20480);
  });

  // audit W-04: a transient 500/internal error must NOT be mapped to the
  // "unavailable for this API key/model/region" message.
  it('surfaces transient server errors instead of blaming the API key/region', async () => {
    mockRunModelInteraction.mockRejectedValueOnce(new Error('500 Internal server error'));

    await expect(
      extractTextFromUrls(
        ['https://example.com'],
        'test-api-key',
        'combined',
        'gemini-3.5-flash-lite',
      ),
    ).rejects.toThrow('500 Internal server error');
  });

  // audit W-04: genuine feature-unavailability still maps to the friendly message.
  it('maps url-context unavailability to the API-key/model/region message', async () => {
    mockRunModelInteraction.mockRejectedValueOnce(new Error('url_context tool is not supported'));

    await expect(
      extractTextFromUrls(
        ['https://example.com'],
        'test-api-key',
        'combined',
        'gemini-3.5-flash-lite',
      ),
    ).rejects.toThrow('Grounded URL retrieval is unavailable for this API key, model, or region.');
  });
});

describe('dedupeRequestedUrls', () => {
  it('removes duplicate URLs that resolve to the same normalized key', () => {
    const { urls, duplicateCount } = dedupeRequestedUrls([
      'https://example.com',
      'https://example.com/',
      'https://example.org',
    ]);
    expect(urls).toEqual(['https://example.com', 'https://example.org']);
    expect(duplicateCount).toBe(1);
  });

  // audit H-05: http and https are distinct, so they are NOT deduped.
  it('keeps http and https variants of the same host', () => {
    const { urls, duplicateCount } = dedupeRequestedUrls([
      'http://example.com',
      'https://example.com',
    ]);
    expect(urls).toEqual(['http://example.com', 'https://example.com']);
    expect(duplicateCount).toBe(0);
  });
});
