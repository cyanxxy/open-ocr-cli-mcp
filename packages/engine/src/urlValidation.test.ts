import { describe, expect, it } from 'vitest';

import { getUnsupportedUrls, isPublicIpAddress, isSupportedHttpUrl, parseSupportedHttpUrl } from './urlValidation';

describe('urlValidation', () => {
  describe('parseSupportedHttpUrl', () => {
    it('accepts http and https URLs', () => {
      expect(parseSupportedHttpUrl('http://example.com')?.protocol).toBe('http:');
      expect(parseSupportedHttpUrl('https://example.com/doc.pdf')?.protocol).toBe('https:');
    });

    it('rejects non-http(s) schemes (the SSRF/XSS-adjacent ones)', () => {
      expect(parseSupportedHttpUrl('javascript:alert(1)')).toBeNull();
      expect(parseSupportedHttpUrl('file:///etc/passwd')).toBeNull();
      expect(parseSupportedHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
      expect(parseSupportedHttpUrl('ftp://example.com/file')).toBeNull();
      expect(parseSupportedHttpUrl('mailto:user@example.com')).toBeNull();
    });

    it('returns null for empty or malformed input', () => {
      expect(parseSupportedHttpUrl('')).toBeNull();
      expect(parseSupportedHttpUrl('not a url')).toBeNull();
      expect(parseSupportedHttpUrl('://missing-scheme')).toBeNull();
    });

    // audit H-08: Gemini URL Context only supports publicly-accessible URLs.
    it('rejects URLs with embedded credentials', () => {
      expect(parseSupportedHttpUrl('http://user:pass@example.com')).toBeNull();
      expect(parseSupportedHttpUrl('https://admin@example.com/secret')).toBeNull();
    });

    it('rejects loopback and localhost hosts', () => {
      expect(parseSupportedHttpUrl('http://localhost/path')).toBeNull();
      expect(parseSupportedHttpUrl('http://127.0.0.1/foo')).toBeNull();
      expect(parseSupportedHttpUrl('http://0.0.0.0/')).toBeNull();
      expect(parseSupportedHttpUrl('http://[::1]/')).toBeNull();
    });

    it('rejects private and link-local IPv4 ranges', () => {
      expect(parseSupportedHttpUrl('http://10.0.0.1/')).toBeNull();
      expect(parseSupportedHttpUrl('http://172.16.0.1/')).toBeNull();
      expect(parseSupportedHttpUrl('http://172.31.255.255/')).toBeNull();
      expect(parseSupportedHttpUrl('http://192.168.1.1/')).toBeNull();
      expect(parseSupportedHttpUrl('http://169.254.1.1/')).toBeNull();
      expect(parseSupportedHttpUrl('http://100.64.0.1/')).toBeNull();
    });

    it('rejects private IPv6 ranges', () => {
      expect(parseSupportedHttpUrl('http://[fd00::1]/')).toBeNull();
      expect(parseSupportedHttpUrl('http://[fe80::1]/')).toBeNull();
      expect(parseSupportedHttpUrl('http://[2001:db8::1]/')).toBeNull();
      expect(parseSupportedHttpUrl('http://[::ffff:7f00:1]/')).toBeNull();
      expect(parseSupportedHttpUrl('http://[::ffff:127.0.0.1]/')).toBeNull();
    });

    it('rejects IPv4-compatible IPv6 literals (::/96) however they are written', () => {
      // The URL parser normalizes [::127.0.0.1] to [::7f00:1], which ipaddr.js
      // labels plain unicast.
      expect(parseSupportedHttpUrl('http://[::127.0.0.1]/')).toBeNull();
      expect(parseSupportedHttpUrl('http://[::7f00:1]/')).toBeNull();
      expect(parseSupportedHttpUrl('http://[::a9fe:a9fe]/latest/meta-data')).toBeNull();
      expect(isPublicIpAddress('::7f00:1')).toBe(false);
      expect(isPublicIpAddress('::a9fe:a9fe')).toBe(false);
      expect(isPublicIpAddress('[::a9fe:a9fe]')).toBe(false);
      expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true);
    });

    it('rejects tunnelling hosts (ngrok/pinggy/localtunnel)', () => {
      expect(parseSupportedHttpUrl('https://abc123.ngrok.io/')).toBeNull();
      expect(parseSupportedHttpUrl('https://abc.ngrok-free.app/')).toBeNull();
      expect(parseSupportedHttpUrl('https://demo.pinggy.io/')).toBeNull();
      expect(parseSupportedHttpUrl('https://demo.loca.lt/')).toBeNull();
    });

    it('still accepts ordinary public hosts (172.x outside the private block, public IPs)', () => {
      expect(parseSupportedHttpUrl('https://example.com/path')?.protocol).toBe('https:');
      expect(parseSupportedHttpUrl('http://172.15.0.1/')?.protocol).toBe('http:');
      expect(parseSupportedHttpUrl('http://8.8.8.8/')?.protocol).toBe('http:');
      expect(parseSupportedHttpUrl('http://[2606:4700:4700::1111]/')?.protocol).toBe('http:');
    });
  });

  describe('isSupportedHttpUrl', () => {
    it('mirrors parseSupportedHttpUrl as a boolean', () => {
      expect(isSupportedHttpUrl('https://example.com')).toBe(true);
      expect(isSupportedHttpUrl('javascript:alert(1)')).toBe(false);
    });
  });

  describe('getUnsupportedUrls', () => {
    it('returns only the unsupported URLs from a mixed list', () => {
      const urls = ['https://ok.com', 'javascript:bad', 'http://ok2.com', 'file:///x'];
      expect(getUnsupportedUrls(urls)).toEqual(['javascript:bad', 'file:///x']);
    });

    it('returns an empty array when every URL is supported', () => {
      expect(getUnsupportedUrls(['https://a.com', 'http://b.com'])).toEqual([]);
    });
  });
});
