/**
 * A source-level guard for calls the contract tests never run. It reads the
 * files that build GitHub requests and checks every API path they mention
 * against the vendored description. It is deliberately a net, not a parser:
 * the exact method/path/status pairs are checked on real traffic by the
 * recorder; this catches a brand-new endpoint that no test exercises yet.
 */

export interface Fragment {
  /** The literal as written, e.g. `${targetPath(target)}/registration-token`. */
  readonly raw: string;
  /** Tokens; `{}` stands for an interpolated part. */
  readonly tokens: readonly string[];
}

const LITERAL = /(?<q>["'`])(?<text>(?:\\.|(?!\k<q>)[^\\\n])*)\k<q>/g;

/** A path-like literal: starts with `/` or with an interpolation. Query strings are dropped. */
function toFragment(text: string): Fragment | null {
  const path = text.replace(/\$\{[^}]*\}/g, '{}').split('?')[0] ?? '';
  if (!(path.startsWith('/') || path.startsWith('{}/'))) return null;
  const tokens = path.split('/').filter((token) => token !== '');
  return tokens.length === 0 ? null : { raw: text, tokens };
}

/** Every path-like string literal in a source file (TypeScript or Python). */
export function pathFragments(source: string): Fragment[] {
  const found: Fragment[] = [];
  for (const match of source.matchAll(LITERAL)) {
    const text = match.groups?.['text'] ?? '';
    const fragment = toFragment(text);
    if (fragment !== null) found.push(fragment);
  }
  return found;
}

const MAX_WILDCARD = 4;

function matchesAt(
  tokens: readonly string[],
  segments: readonly string[]
): boolean {
  const [token, ...rest] = tokens;
  if (token === undefined) return true;
  if (!token.includes('{}'))
    return segments[0] === token && matchesAt(rest, segments.slice(1));
  for (let take = 1; take <= Math.min(MAX_WILDCARD, segments.length); take += 1)
    if (matchesAt(rest, segments.slice(take))) return true;
  return false;
}

/** True when the fragment appears, in order, inside one of the description's path templates. */
export function fragmentInDescription(
  fragment: Fragment,
  templates: readonly string[]
): boolean {
  return templates.some((template) => {
    const segments = template.split('/').filter(Boolean);
    return segments.some((_, start) =>
      matchesAt(fragment.tokens, segments.slice(start))
    );
  });
}

/** The HTTP methods a source file names as string literals. */
export function methodsNamed(source: string): Set<string> {
  const names = source.match(
    /(?<=["'`])(GET|POST|PUT|PATCH|DELETE|HEAD)(?=["'`])/g
  );
  return new Set(names ?? []);
}

/** Top-level resources of GitHub's REST API that are not in the vendored subset but would be GitHub calls. */
const GITHUB_ROOTS = new Set([
  'user',
  'users',
  'search',
  'gists',
  'enterprises',
  'rate_limit',
  'meta',
  'applications',
  'marketplace_listing',
  'teams',
  'projects',
  'notifications',
  'organizations',
  'repositories',
  'advisories',
  'assignments',
  'classrooms',
  'events',
  'feeds',
  'licenses',
  'emojis',
  'orgs',
  'repos',
  'app',
  'installation',
]);

/**
 * For files that mix GitHub paths with local ones (the node-side Python): keep
 * the fragments whose first segment is a GitHub API resource or a segment the
 * vendored description already uses.
 */
export function githubLooking(
  fragment: Fragment,
  templates: readonly string[]
): boolean {
  const first = fragment.tokens[0] ?? '';
  const known = templates.some((t) => t.split('/').includes(first));
  return known || GITHUB_ROOTS.has(first);
}
