/**
 * Markdown helpers shared by the simple-mode section parser and the tolerant
 * JSON extractor. Both need to agree on what a fenced code block is: a parser
 * that closes a fence on any line beginning with three backticks breaks every
 * four-backtick outer fence and every nested fence (CommonMark §4.5).
 */

import type { ExtractedContent } from './types';

export interface FenceOpener {
  /** `` ` `` or `~`. */
  char: '`' | '~';
  /** Run length of the opening fence (at least 3). */
  length: number;
  /** The info string (first word is the language), trimmed. */
  info: string;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;

/** Parse a CommonMark fence opener, or return undefined when the line is not one. */
export function parseFenceOpener(line: string): FenceOpener | undefined {
  const match = FENCE_OPEN.exec(line);
  if (!match) return undefined;
  const run = match[1];
  const info = match[2].trim();
  // A backtick fence's info string may not itself contain a backtick; such a
  // line is inline code, not a fence.
  if (run[0] === '`' && info.includes('`')) return undefined;
  return { char: run[0] as FenceOpener['char'], length: run.length, info };
}

/**
 * Whether `line` closes the fence opened by `opener`: the same character, a run
 * at least as long as the opener's, and no info string.
 */
export function closesFence(line: string, opener: FenceOpener): boolean {
  const match = FENCE_CLOSE.exec(line);
  if (!match) return false;
  return match[1][0] === opener.char && match[1].length >= opener.length;
}

/** The language word of a fence's info string, lowercased. */
export function fenceLanguage(opener: FenceOpener): string {
  return opener.info.split(/\s+/u)[0]?.toLowerCase() ?? '';
}

export interface FencedBlock {
  language: string;
  content: string;
}

/** Every fenced code block in `text`, in document order. An unclosed fence runs to the end. */
export function fencedBlocks(text: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let opener: FenceOpener | undefined;
  let body: string[] = [];
  for (const line of text.split('\n')) {
    if (!opener) {
      opener = parseFenceOpener(line);
      body = [];
      continue;
    }
    if (closesFence(line, opener)) {
      blocks.push({ language: fenceLanguage(opener), content: body.join('\n') });
      opener = undefined;
      continue;
    }
    body.push(line);
  }
  if (opener) blocks.push({ language: fenceLanguage(opener), content: body.join('\n') });
  return blocks;
}

const LEADING_REASONING_BLOCK = /^\s*<(think|thinking|reasoning)>[\s\S]*?<\/\1>/iu;
const TRAILING_REASONING_BLOCK = /<(think|thinking|reasoning)>(?:(?!<\1>)[\s\S])*?<\/\1>\s*$/iu;

/**
 * Remove `<think>…</think>` style reasoning that some OpenAI-compatible
 * reasoning models emit inline before (or, rarely, after) their answer. Only
 * whole blocks at the very start or end are removed; a tag in the middle of the
 * document is the document's own text and is left alone.
 */
export function stripReasoningBlocks(text: string): string {
  let result = text;
  for (let guard = 0; guard < 16; guard += 1) {
    const next = result.replace(LEADING_REASONING_BLOCK, '');
    if (next === result) break;
    result = next;
  }
  for (let guard = 0; guard < 16; guard += 1) {
    const next = result.replace(TRAILING_REASONING_BLOCK, '');
    if (next === result) break;
    result = next;
  }
  return result;
}

/**
 * The model's Markdown, preserved: line endings normalized to LF, inline
 * reasoning blocks at either end removed, and blank lines at either end
 * dropped. Indentation of the first line and trailing spaces of the last line
 * are kept, since both are significant Markdown (indented code, hard breaks).
 */
export function normalizeModelMarkdown(text: string): string {
  const lf = text.replace(/\r\n?/gu, '\n');
  return stripReasoningBlocks(lf)
    .replace(/^(?:[ \t]*\n)+/u, '')
    .replace(/(?:\n[ \t]*)+$/u, '')
    .replace(/^[ \t]+$/u, '');
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/u;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/u;
/** Lines that cannot be a setext heading's text: block starts of other kinds. */
const NON_PARAGRAPH_START = /^(?: {4}|\t| {0,3}(?:[-*+]\s|\d{1,9}[.)]\s|>|\||#{1,6}(?:\s|$)|`{3}|~{3}|<))/u;

function atxHeadingText(raw: string): string {
  // Strip an optional closing sequence ("## Title ##") and surrounding space.
  return raw.replace(/[ \t]+#+[ \t]*$/u, '').replace(/^[ \t]*#+[ \t]*$/u, '').trim();
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end);
}

type Section = ExtractedContent['sections'][number];

/**
 * Split Markdown into a title and heading-delimited sections.
 *
 * Headings inside fenced code blocks and indented code are content, never
 * section breaks; each section records its heading's `level` so a consumer can
 * rebuild the outline without flattening `###` into `##`. A leading H1 with no
 * text before it becomes the title; any other H1 is a level-1 section.
 */
export function markdownToSections(markdown: string): Pick<ExtractedContent, 'title' | 'sections'> {
  const lines = markdown.split('\n');
  const sections: Section[] = [];
  let title: string | undefined;
  let current: { heading?: string; level?: number; content: string[] } = { content: [] };
  let fence: FenceOpener | undefined;

  const commit = (): void => {
    const content = trimBlankEdges(current.content);
    if (current.heading !== undefined || content.some((line) => line.trim() !== '')) {
      sections.push({
        ...(current.heading !== undefined ? { heading: current.heading } : {}),
        ...(current.level !== undefined ? { level: current.level } : {}),
        content,
      });
    }
  };

  const startSection = (heading: string, level: number): void => {
    if (
      level === 1
      && title === undefined
      && sections.length === 0
      && current.heading === undefined
      && current.content.every((line) => line.trim() === '')
    ) {
      title = heading;
      current = { content: [] };
      return;
    }
    commit();
    current = { heading, level, content: [] };
  };

  for (const line of lines) {
    if (fence) {
      current.content.push(line);
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }
    const opener = parseFenceOpener(line);
    if (opener) {
      fence = opener;
      current.content.push(line);
      continue;
    }
    const atx = ATX_HEADING.exec(line);
    if (atx) {
      startSection(atxHeadingText(atx[2]), atx[1].length);
      continue;
    }
    const setext = SETEXT_UNDERLINE.exec(line);
    if (setext) {
      // A setext heading underlines exactly one preceding paragraph line here;
      // a dash run after a blank line is a thematic break, not a heading.
      const previous = current.content.at(-1);
      const beforePrevious = current.content.at(-2);
      if (
        previous !== undefined
        && previous.trim() !== ''
        && !NON_PARAGRAPH_START.test(previous)
        && (beforePrevious === undefined || beforePrevious.trim() === '')
      ) {
        current.content.pop();
        startSection(previous.trim(), setext[1][0] === '=' ? 1 : 2);
        continue;
      }
    }
    current.content.push(line);
  }
  commit();
  return { ...(title !== undefined ? { title } : {}), sections };
}

/**
 * Rebuild Markdown from structured sections, honouring each section's `level`
 * (default 2) and separating blocks with exactly one blank line.
 */
export function sectionsToMarkdown(content: Pick<ExtractedContent, 'title' | 'sections' | 'content'>): string {
  const blocks: string[] = [];
  if (content.title?.trim()) blocks.push(`# ${content.title.trim()}`);
  for (const section of content.sections) {
    const level = Math.min(6, Math.max(1, Math.trunc(section.level ?? 2)));
    if (section.heading?.trim()) blocks.push(`${'#'.repeat(level)} ${section.heading.trim()}`);
    const body = trimBlankEdges(section.content.flatMap((line) => line.replace(/\r\n?/gu, '\n').split('\n')));
    if (body.length > 0) blocks.push(body.join('\n'));
  }
  if (blocks.length === 0 && content.content?.trim()) blocks.push(content.content.trim());
  return blocks.join('\n\n');
}
