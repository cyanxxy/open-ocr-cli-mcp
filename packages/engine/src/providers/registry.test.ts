import { describe, expect, it } from 'vitest';

import {
  estimateProviderRequestCostUsd,
  isKimiK3Route,
  isLocalBaseUrl,
  knownModelThinkingLevels,
  providerDefaultThinkingLevel,
  providerProfile,
  providerTokenPrice,
  resolveProviderBaseUrl,
} from './registry';

describe('provider registry routing', () => {
  it('keeps current OCR defaults and model-specific reasoning contracts aligned across routes', () => {
    expect(providerProfile('gemini').defaultModel).toBe('gemini-3.8-flash');
    expect(providerProfile('openrouter').defaultModel).toBe('google/gemini-3.8-flash');
    expect(providerProfile('muse').defaultModel).toBe('muse-spark-1.3');
    expect(providerProfile('muse').models.some((model) => model.endsWith('-contributor'))).toBe(false);
    for (const model of ['gemini-3.8-flash', 'gemini-3.7-flash']) {
      expect(knownModelThinkingLevels('gemini', model)).toEqual(['LOW', 'MEDIUM', 'HIGH']);
      expect(knownModelThinkingLevels('openrouter', `google/${model}:nitro`)).toEqual(['LOW', 'MEDIUM', 'HIGH']);
    }
    expect(providerDefaultThinkingLevel('openrouter', 'google/gemini-3.5-flash-lite')).toBe('MINIMAL');
    expect(knownModelThinkingLevels('muse', 'muse-spark-1.3')).toContain('MAX');
    expect(knownModelThinkingLevels('muse', 'muse-spark-1.3-contributor')).not.toContain('MAX');
    expect(knownModelThinkingLevels('openrouter', 'openai/gpt-6.1-sol')).not.toContain('MINIMAL');
    expect(knownModelThinkingLevels('openrouter', 'moonshotai/kimi-k2.7-code')).toEqual(['HIGH']);
    expect(knownModelThinkingLevels('openrouter', 'moonshotai/kimi-k2.6')).toEqual(['MINIMAL', 'HIGH']);
  });

  it('recognizes IPv6 loopback without classifying other IPv6 hosts as local', () => {
    expect(isLocalBaseUrl('http://[::1]:11434/v1')).toBe(true);
    expect(isLocalBaseUrl('https://[2001:db8::1]/v1')).toBe(false);
    expect(isLocalBaseUrl('https://localhost.example.test/v1')).toBe(false);
  });
  it('recognizes Kimi K3 through direct, revisioned, and OpenRouter variant routes', () => {
    expect(isKimiK3Route('kimi', 'kimi-k3')).toBe(true);
    expect(isKimiK3Route('kimi', 'kimi-k3-preview')).toBe(true);
    expect(isKimiK3Route('openrouter', 'moonshotai/kimi-k3')).toBe(true);
    expect(isKimiK3Route('openrouter', 'moonshotai/kimi-k3:exacto')).toBe(true);
    expect(isKimiK3Route('openrouter', 'moonshotai/kimi-k2.7-code')).toBe(false);
  });

  it('uses native Cloudflare routes for Gemini and OpenRouter', () => {
    expect(resolveProviderBaseUrl({
      provider: 'gemini',
      gateway: 'cloudflare',
      cloudflareAccountId: 'a/b',
      cloudflareGatewayId: 'g one',
    })).toBe('https://gateway.ai.cloudflare.com/v1/a%2Fb/g%20one/google-ai-studio');
    expect(resolveProviderBaseUrl({
      provider: 'openrouter',
      gateway: 'cloudflare',
      cloudflareAccountId: 'account',
      cloudflareGatewayId: 'gateway',
    })).toBe('https://gateway.ai.cloudflare.com/v1/account/gateway/openrouter');
  });

  it('advertises only image MIME types accepted by each known transport and this CLI', () => {
    expect(providerProfile('gemini').inputImageMimeTypes).toEqual([
      'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif',
    ]);
    expect(providerProfile('kimi').inputImageMimeTypes).toEqual([
      'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    ]);
    expect(providerProfile('muse').inputImageMimeTypes).toEqual([
      'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    ]);
    expect(providerProfile('muse').capabilities.pdfs).toBe(true);
    expect(providerProfile('openrouter').inputImageMimeTypes).toEqual([
      'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    ]);
    expect(providerProfile('openai-compatible').inputImageMimeTypes).toBeUndefined();
  });

  it('requires an explicit custom-provider slug for other gateway profiles', () => {
    expect(() => resolveProviderBaseUrl({
      provider: 'kimi',
      gateway: 'cloudflare',
      cloudflareAccountId: 'account',
      cloudflareGatewayId: 'gateway',
    })).toThrow('cloudflareProvider');
  });

  it('provides only verifiable built-in prices and keeps Kimi cache rates', () => {
    expect(providerTokenPrice({ provider: 'muse', model: 'muse-spark-1.3' }, 0)).toEqual({
      inputPerMillionUsd: 1.25,
      cachedInputPerMillionUsd: 0.15,
      outputPerMillionUsd: 4.25,
    });
    expect(providerTokenPrice({ provider: 'kimi', model: 'kimi-k2.6' }, 0)).toEqual({
      inputPerMillionUsd: 0.95,
      cachedInputPerMillionUsd: 0.16,
      outputPerMillionUsd: 4,
    });
    expect(providerTokenPrice({ provider: 'kimi', model: 'kimi-k2.7-code-highspeed' }, 0)).toEqual({
      inputPerMillionUsd: 1.9,
      cachedInputPerMillionUsd: 0.38,
      outputPerMillionUsd: 8,
    });
    expect(estimateProviderRequestCostUsd(
      { provider: 'kimi', model: 'kimi-k2.6' },
      1_000_000,
      100_000,
      0,
      250_000,
    )).toBe(1.1525);
  });

  it('uses the published Gemini standard context-cache rates', () => {
    expect(providerTokenPrice({ provider: 'gemini', model: 'gemini-3.5-flash' }, 0)).toEqual({
      inputPerMillionUsd: 1.5,
      cachedInputPerMillionUsd: 0.15,
      outputPerMillionUsd: 9,
    });
    expect(providerTokenPrice({ provider: 'gemini', model: 'gemini-3.1-pro-preview' }, 200_001)).toEqual({
      inputPerMillionUsd: 4,
      cachedInputPerMillionUsd: 0.4,
      outputPerMillionUsd: 18,
    });
  });

  it('applies scheduled Gemini price changes at the published UTC boundary', () => {
    for (const model of ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash']) {
      expect(providerTokenPrice({ provider: 'gemini', model }, 0, Date.UTC(2026, 11, 31, 23, 59, 59))).toEqual({
        inputPerMillionUsd: 0.75, cachedInputPerMillionUsd: 0.075, outputPerMillionUsd: 3.75,
      });
      expect(providerTokenPrice({ provider: 'gemini', model }, 0, Date.UTC(2027, 0, 1))).toEqual({
        inputPerMillionUsd: 1.5, cachedInputPerMillionUsd: 0.15, outputPerMillionUsd: 7.5,
      });
    }
    expect(providerTokenPrice({ provider: 'gemini', model: 'gemini-3.5-flash-lite' }, 0)).toEqual({
      inputPerMillionUsd: 0.3, cachedInputPerMillionUsd: 0.03, outputPerMillionUsd: 2.5,
    });
  });

  it('uses route-specific prices and never assumes billing for a generic endpoint', () => {
    expect(providerTokenPrice({ provider: 'openrouter', model: 'moonshotai/kimi-k3' }, 0)).toEqual({
      inputPerMillionUsd: 2.7, cachedInputPerMillionUsd: 0.27, outputPerMillionUsd: 13.5,
    });
    expect(providerTokenPrice({ provider: 'muse', model: 'muse-spark-1.3-contributor' }, 0)).toEqual({
      inputPerMillionUsd: 0.1, cachedInputPerMillionUsd: 0.002, outputPerMillionUsd: 0.2,
    });
    expect(providerTokenPrice({ provider: 'openai-compatible', model: 'gemini-3.8-flash' }, 0)).toBeUndefined();
    expect(providerTokenPrice({ provider: 'kimi', model: 'gemini-3.8-flash' }, 0)).toBeUndefined();
    expect(providerTokenPrice({ provider: 'openrouter', model: 'openai/gpt-6.1-sol' }, 272_000)).toEqual({
      inputPerMillionUsd: 4, cachedInputPerMillionUsd: 0.2, outputPerMillionUsd: 15,
    });
  });
});
