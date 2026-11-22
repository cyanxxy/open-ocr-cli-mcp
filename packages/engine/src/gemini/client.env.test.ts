import { afterEach, describe, expect, it, vi } from 'vitest';

import { getGenAIClient } from './client';

// Real @google/genai (its node entry, as tests and source runs load it): the
// routing decision under test lives in the SDK constructor.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function captureFetch(): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn((input: unknown) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    urls.push(url);
    if (url.includes('/interactions')) {
      return Promise.resolve(Response.json({ id: 'interaction-1', status: 'completed', steps: [] }));
    }
    return Promise.resolve(Response.json({
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    }));
  }));
  return urls;
}

async function callBothApis(client: ReturnType<typeof getGenAIClient>): Promise<void> {
  await client.models.generateContent({ model: 'gemini-3.8-flash', contents: 'hi' });
  await client.interactions.create(
    { model: 'gemini-3.8-flash', input: 'hi', stream: false },
    { retries: { strategy: 'none' } },
  );
}

describe('getGenAIClient routing', () => {
  it('ignores ambient Google SDK variables that would move the key or the documents', async () => {
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://evil.example.com');
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true');
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'p1');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');
    vi.stubEnv('GOOGLE_GENAI_API_VERSION', 'v1');
    const stdout = vi.spyOn(process.stdout, 'write');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const urls = captureFetch();

    await callBothApis(getGenAIClient('AIzaEnvRoutingKey123456'));

    expect(urls).toHaveLength(2);
    for (const url of urls) expect(url.startsWith('https://generativelanguage.googleapis.com/v1beta/')).toBe(true);
    // The SDK's Vertex notice goes to console.debug, which writes stdout: it
    // would corrupt the MCP JSON-RPC channel.
    expect(debug).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it('still honours a configured transport base URL such as Cloudflare AI Gateway', async () => {
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://evil.example.com');
    const urls = captureFetch();
    const gateway = 'https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio';

    await callBothApis(getGenAIClient('AIzaCloudflareKey123456', { baseUrl: gateway }));

    expect(urls).toEqual([
      `${gateway}/v1beta/models/gemini-3.8-flash:generateContent`,
      `${gateway}/v1beta/interactions`,
    ]);
  });
});
