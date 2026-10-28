/**
 * Markdown building blocks that stay safe with node-controlled text: values
 * go in code spans or fenced blocks sized to outgrow any backtick run they
 * contain, so a hostile message cannot close the block, add links or images,
 * or mention people.
 */

const MIN_FENCE = 3;

function longestRun(text: string, char: string): number {
  let longest = 0;
  let current = 0;
  for (const c of text) {
    current = c === char ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

/** A single-line code span for any text. */
export function inline(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const clipped = flat.length > max ? `${flat.slice(0, max)}...` : flat;
  const ticks = '`'.repeat(longestRun(clipped, '`') + 1);
  const pad = clipped.startsWith('`') || clipped.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${clipped === '' ? ' ' : clipped}${pad}${ticks}`;
}

/** The lines inside a fenced block that no content line can close. */
export function fenced(lines: readonly string[], language = ''): string[] {
  const fence = '`'.repeat(
    Math.max(MIN_FENCE, longestRun(lines.join('\n'), '`') + 1)
  );
  return [`${fence}${language}`, ...lines, fence];
}

/** One line of plain text with line breaks and control characters removed. */
export function oneLine(text: string, max = 200): string {
  const flat = text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** A title or label fragment limited to characters that cannot carry markup or mentions. */
export function safeWord(text: string, max = 40): string {
  return text
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
}

export interface Section {
  readonly title: string;
  /** Plain Markdown lines placed before the content. Never truncated. */
  readonly intro?: readonly string[];
  /** Content lines; truncated from the end, with a marker, when the body is too long. */
  readonly lines: readonly string[];
  /** Wrap the content in a code fence (after truncation). */
  readonly fence?: string;
  /** False keeps the section whole (short and essential). */
  readonly truncatable?: boolean;
}

const MIN_KEPT = 3;

function truncationMarker(removed: number): string {
  return `[truncated ${removed} lines]`;
}

function renderSection(section: Section): string {
  const content =
    section.fence === undefined
      ? section.lines
      : fenced(section.lines, section.fence);
  return [
    `## ${section.title}`,
    '',
    ...(section.intro ?? []),
    ...content,
    '',
  ].join('\n');
}

function weight(section: Section): number {
  if (section.truncatable === false || section.lines.length <= MIN_KEPT)
    return 0;
  return section.lines.reduce((total, line) => total + line.length + 1, 0);
}

function shorten(section: Section): Section {
  const keep = Math.max(MIN_KEPT, Math.ceil(section.lines.length / 2));
  const removed = section.lines.length - keep;
  return {
    ...section,
    lines: [...section.lines.slice(0, keep), truncationMarker(removed)],
  };
}

export interface Fitted {
  readonly text: string;
  readonly truncated: readonly string[];
}

/**
 * Joins the sections and, while the result exceeds `limit`, halves the
 * largest truncatable section, marking every cut with `[truncated N lines]`.
 * Last resort: cut the whole body at the limit, also marked.
 */
export function fitSections(
  head: string,
  sections: readonly Section[],
  limit: number
): Fitted {
  let current = [...sections];
  const cut = new Set<string>();
  const total = () =>
    head.length + current.reduce((n, s) => n + renderSection(s).length + 1, 0);
  while (total() > limit) {
    const heaviest = current.reduce(
      (best, s, i) => (weight(s) > weight(current[best]!) ? i : best),
      0
    );
    if (weight(current[heaviest]!) === 0) break;
    cut.add(current[heaviest]!.title);
    current = current.map((s, i) => (i === heaviest ? shorten(s) : s));
  }
  const text = [head, ...current.map(renderSection)].join('\n');
  if (text.length <= limit) return { text, truncated: [...cut] };
  const marker = `\n\n${truncationMarker(text.slice(limit).split('\n').length)}\n`;
  return {
    text: text.slice(0, limit - marker.length) + marker,
    truncated: [...cut, 'body'],
  };
}
