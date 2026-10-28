import { freePort } from '../support/port';

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request?: unknown;
}

export interface Injection {
  /** Matched against `METHOD /path`. */
  readonly match: RegExp;
  /** How many matching requests it affects; Infinity for all. */
  times: number;
  readonly respond: (request: Request) => Response | Promise<Response>;
  /** Also let the real handler run first (the effect happens, the answer is lost). */
  readonly afterEffect?: boolean;
}

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

/**
 * A loopback stand-in for the part of the GitHub issues API the controller
 * uses, with failure injection. It never touches the network.
 */
export class FakeIssuesApi {
  readonly issues: FakeIssue[] = [];
  readonly comments: { number: number; body: string }[] = [];
  readonly calls: Call[] = [];
  readonly injections: Injection[] = [];
  token = 'ghp_FAKEtokenFAKEtokenFAKEtoken000000';
  repository = 'acme/fleet-reports';
  clock = () => new Date().toISOString();
  private server: ReturnType<typeof Bun.serve> | null = null;
  url = '';

  async start(): Promise<void> {
    const port = await freePort();
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch: (request) => this.handle(request),
    });
    this.url = `http://127.0.0.1:${port}`;
  }

  stop(): void {
    void this.server?.stop(true);
  }

  inject(injection: Injection): void {
    this.injections.push(injection);
  }

  reset(): void {
    this.issues.length = 0;
    this.comments.length = 0;
    this.calls.length = 0;
    this.injections.length = 0;
  }

  creates(): Call[] {
    return this.calls.filter(
      (call) => call.method === 'POST' && call.path.endsWith('/issues')
    );
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const text = request.method === 'GET' ? '' : await request.clone().text();
    const body: unknown = text === '' ? null : JSON.parse(text);
    this.calls.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get('authorization'),
      body,
    });
    const key = `${request.method} ${url.pathname}`;
    const hit = this.injections.find((i) => i.times > 0 && i.match.test(key));
    if (hit !== undefined) {
      hit.times -= 1;
      if (hit.afterEffect === true) await this.route(request, url, body);
      return hit.respond(request);
    }
    return this.route(request, url, body);
  }

  private json(status: number, value: unknown): Response {
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  private async route(
    request: Request,
    url: URL,
    body: unknown
  ): Promise<Response> {
    if (request.headers.get('authorization') !== `Bearer ${this.token}`)
      return this.json(401, { message: 'Bad credentials' });
    const base = `/repos/${this.repository}/issues`;
    if (!url.pathname.startsWith(base))
      return this.json(404, { message: 'Not Found' });
    return this.routeIssues(
      request,
      url.pathname.slice(base.length),
      url,
      body
    );
  }

  private routeIssues(
    request: Request,
    rest: string,
    url: URL,
    body: unknown
  ): Response {
    if (request.method === 'GET' && rest === '') return this.list(url);
    if (request.method === 'POST' && rest === '')
      return this.create(body as Record<string, unknown>);
    const comment = /^\/(\d+)\/comments$/.exec(rest);
    if (request.method === 'POST' && comment !== null) {
      this.comments.push({
        number: Number(comment[1]),
        body: String((body as Record<string, unknown>)['body']),
      });
      return this.json(201, { id: this.comments.length });
    }
    const one = /^\/(\d+)$/.exec(rest);
    const found =
      one === null
        ? undefined
        : this.issues.find((i) => i.number === Number(one[1]));
    return request.method === 'GET' && found !== undefined
      ? this.json(200, found)
      : this.json(404, { message: 'Not Found' });
  }

  private list(url: URL): Response {
    const since = url.searchParams.get('since');
    const state = url.searchParams.get('state') ?? 'open';
    const page = Number(url.searchParams.get('page') ?? '1');
    const per = Number(url.searchParams.get('per_page') ?? '30');
    const rows = this.issues
      .filter((issue) => since === null || issue.updated_at >= since)
      .filter((issue) => state === 'all' || issue.state === state)
      .sort((a, b) => b.number - a.number)
      .slice((page - 1) * per, page * per);
    return this.json(200, rows);
  }

  private create(body: Record<string, unknown>): Response {
    const number = this.issues.length + 1;
    const now = this.clock();
    const issue: FakeIssue = {
      number,
      title: String(body['title']),
      body: String(body['body']),
      state: 'open',
      labels: Array.isArray(body['labels']) ? (body['labels'] as string[]) : [],
      created_at: now,
      updated_at: now,
      html_url: `https://github.com/${this.repository}/issues/${number}`,
    };
    this.issues.push(issue);
    return this.json(201, issue);
  }
}

export const status =
  (code: number, message = 'injected', headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify({ message }), {
      status: code,
      headers: { 'content-type': 'application/json', ...headers },
    });
