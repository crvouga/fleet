/** GitHub refuses much longer "new issue" addresses; stay clear of it. */
export const NEW_ISSUE_URL_MAX = 7500;
const NOTE =
  '\n\n[Shortened for the length of a web address. Use "Copy report" on the Fleet controller page for the full report.]';

function address(
  origin: string,
  repository: string,
  fields: Record<string, string>
): string {
  const query = new URLSearchParams(fields).toString();
  return `${origin}/${repository}/issues/new?${query}`;
}

function cutAtLine(text: string, length: number): string {
  const head = text.slice(0, length);
  const line = head.lastIndexOf('\n');
  return line > length / 2 ? head.slice(0, line) : head;
}

/**
 * A prefilled "new issue" address for a repository, with the body shortened
 * (at a line boundary, with a note) until the whole address fits. The
 * fingerprint marker is on the first line of every body, so it survives.
 */
export function newIssueUrl(input: {
  readonly origin: string;
  readonly repository: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}): string {
  const build = (body: string): string =>
    address(input.origin, input.repository, {
      title: input.title,
      body,
      ...(input.labels.length === 0 ? {} : { labels: input.labels.join(',') }),
    });
  if (build(input.body).length <= NEW_ISSUE_URL_MAX) return build(input.body);
  let low = 0;
  let high = input.body.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (build(cutAtLine(input.body, middle) + NOTE).length <= NEW_ISSUE_URL_MAX)
      low = middle;
    else high = middle - 1;
  }
  return build(cutAtLine(input.body, low) + NOTE);
}
