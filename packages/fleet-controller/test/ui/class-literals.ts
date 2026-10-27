/** Finds the Tailwind class lists written in the dashboard's source files. */

const STRING = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/gs;

function literalsIn(source: string): string[] {
  return [...source.matchAll(STRING)].map((m) => m[2] ?? '');
}

/** Source of the expression after `class={`, up to its matching brace. */
function braceBody(source: string, start: number): string {
  let depth = 1;
  let index = start;
  while (index < source.length && depth > 0) {
    const char = source[index];
    if (char === '"' || char === "'" || char === '`') {
      const end = source.indexOf(char, index + 1);
      index = end === -1 ? source.length : end;
    } else if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    index += 1;
  }
  return source.slice(start, index - 1);
}

/** Every string literal that is a class attribute value or a tw("...") argument. */
export function classLiterals(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\bclass=(\{|"([^"]*)"|'([^']*)')/g)) {
    if (match[1] === '{') {
      found.push(
        ...literalsIn(braceBody(source, (match.index ?? 0) + match[0].length))
      );
    } else {
      found.push(match[2] ?? match[3] ?? '');
    }
  }
  for (const match of source.matchAll(
    /\btw\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/gs
  )) {
    found.push(match[2] ?? '');
  }
  return found;
}

/** Words that are markers or hooks, not utilities. */
const NOT_UTILITIES = new Set(['group', 'peer']);

export function classTokens(source: string): string[] {
  const tokens = classLiterals(source)
    .flatMap((literal) => literal.split(/\s+/))
    .filter(
      (token) =>
        token !== '' && !token.includes('${') && !NOT_UTILITIES.has(token)
    );
  return [...new Set(tokens)];
}

/** The selector text a class name produces in compiled CSS. */
export function selectorFor(token: string): string {
  return `.${token.replace(/[^A-Za-z0-9_-]/g, (char) => `\\${char}`)}`;
}
