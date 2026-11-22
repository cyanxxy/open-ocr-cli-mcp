import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  GEMINI_MODELS,
  knownModelThinkingLevels,
  providerDefaultThinkingLevel,
} from '@open-ocr/engine/providers';
import { describe, expect, it } from 'vitest';

// Guards for the shipped documentation: the human guides and the agent skill
// must give the same advice, and the model tables must follow the registry.
const readme = path.resolve('README.md');
const agentGuide = path.resolve('docs/agent-integrations.md');
const cliReference = path.resolve('docs/cli-reference.md');
const repositorySkill = path.resolve('integrations/open-ocr/skills/open-ocr/SKILL.md');

const PROBE_REMEDY = 'MCP_PROTOCOL_NEGOTIATION=auto';

/** The text from `start` up to the next `end` marker (or the end of the file). */
function section(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `missing ${JSON.stringify(start)}`).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from + start.length);
  return text.slice(from, to < 0 ? undefined : to);
}

describe('Claude Code stdio probe guidance', () => {
  it('gives MCP_PROTOCOL_NEGOTIATION=auto as the first fix in the agent guide, before the CLI fallback', async () => {
    const claudeCode = section(await readFile(agentGuide, 'utf8'), '\n## Claude Code\n', '\n## ');
    const remedy = claudeCode.indexOf(PROBE_REMEDY);
    expect(remedy, 'the Claude Code section must name the remedy').toBeGreaterThanOrEqual(0);
    expect(claudeCode).toMatch(/7\s+days/u);
    expect(claudeCode).toContain('2.1.221');
    const fallback = claudeCode.indexOf('[CLI protocol](#portable-cli-integration)');
    expect(fallback).toBeGreaterThan(remedy);
  });

  it('gives the same remedy in the README Claude Code block', async () => {
    const claudeCode = section(await readFile(readme, 'utf8'), '**Claude Code**', '**Codex**');
    expect(claudeCode).toContain(PROBE_REMEDY);
    expect(claudeCode).toMatch(/7\s+days/u);
  });

  it('keeps the skill consistent with the guide', async () => {
    const skill = await readFile(repositorySkill, 'utf8');
    expect(skill).toContain(PROBE_REMEDY);
    expect(skill).toMatch(/7\s+days/u);
    expect(skill).toContain('2.1.221');
  });
});

describe('documented Gemini models', () => {
  it('lists every curated Gemini model in the README provider table', async () => {
    const geminiRow = (await readFile(readme, 'utf8'))
      .split('\n')
      .find((line) => line.startsWith('| `gemini` (default)'));
    expect(geminiRow).toBeDefined();
    const listed = [...geminiRow!.matchAll(/`(gemini-[^`]+)`/gu)].map((match) => match[1]);
    expect(listed).toEqual([...GEMINI_MODELS]);
  });

  it('documents each Gemini model with the thinking levels and default the registry enforces', async () => {
    const rows = (await readFile(cliReference, 'utf8'))
      .split('\n')
      .filter((line) => line.startsWith('| `gemini-'));
    const documented = new Map<string, { levels: string[]; defaultLevel: string }>();
    for (const row of rows) {
      const [models, levels, defaultLevel] = row.split('|').slice(1, 4)
        .map((cell) => [...cell.matchAll(/`([^`]+)`/gu)].map((match) => match[1]));
      for (const model of models) documented.set(model, { levels, defaultLevel: defaultLevel[0] });
    }
    expect([...documented.keys()].sort()).toEqual([...GEMINI_MODELS].sort());
    for (const model of GEMINI_MODELS) {
      expect(documented.get(model), model).toEqual({
        levels: (knownModelThinkingLevels('gemini', model) ?? []).map((level) => level.toLowerCase()),
        defaultLevel: providerDefaultThinkingLevel('gemini', model).toLowerCase(),
      });
    }
  });
});
