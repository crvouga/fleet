import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';

import type { Flash } from './lib/flash';
import { Icon } from './components/icon';
import { cx, tw } from './lib/tw';

export interface ShellProps {
  readonly title: string;
  readonly path: string;
  readonly actor: string;
  readonly pendingCount: number;
  readonly flash: Flash | null;
  readonly children?: Child;
}

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly match: (path: string) => boolean;
}

const NAV: readonly NavItem[] = [
  { href: '/access', label: 'Access', match: (p) => p === '/access' },
  { href: '/', label: 'Overview', match: (p) => p === '/' || p === '/add' },
  { href: '/nodes', label: 'Nodes', match: (p) => p.startsWith('/nodes') },
  { href: '/pending', label: 'Pending', match: (p) => p === '/pending' },
  { href: '/events', label: 'Events', match: (p) => p.startsWith('/events') },
  {
    href: '/settings',
    label: 'Settings',
    match: (p) => p.startsWith('/settings'),
  },
];

const NAV_LINK = tw(
  'relative inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium no-underline transition-colors'
);

function Head(props: { title: string }) {
  return (
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="color-scheme" content="light dark" />
      <meta name="robots" content="noindex" />
      <script src="/assets/theme-init.js" />
      <title>{`${props.title} · Fleet`}</title>
      <link rel="stylesheet" href="/assets/app.css" />
      <link rel="stylesheet" href="/assets/console.css" />
      <link
        rel="icon"
        href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='6' fill='%232563eb'/%3E%3Cpath d='M6 8h12M6 12h12M6 16h12' stroke='white' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E"
      />
    </head>
  );
}

function Brand() {
  return (
    <a
      href="/"
      class="flex items-center gap-2 text-fg no-underline"
      aria-label="Fleet home"
    >
      <span class="grid size-7 place-items-center rounded-lg bg-accent text-white">
        <Icon name="server" class="size-4" />
      </span>
      <span class="text-base font-semibold tracking-tight">Fleet</span>
    </a>
  );
}

function PendingBadge(props: { count: number }) {
  if (props.count === 0) return null;
  return (
    <span class="tabular inline-flex min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-semibold text-white">
      {props.count}
      <span class="sr-only"> waiting for approval</span>
    </span>
  );
}

function Nav(props: { path: string; pendingCount: number }) {
  return (
    <nav
      aria-label="Main"
      class="order-last -mx-1 flex w-full gap-1 overflow-x-auto md:order-none md:mx-0 md:w-auto"
    >
      {NAV.map((item) => {
        const current = item.match(props.path);
        return (
          <a
            key={item.href}
            href={item.href}
            aria-current={current ? 'page' : undefined}
            class={cx(
              NAV_LINK,
              current
                ? 'bg-muted text-fg'
                : 'text-fg-2 hover:bg-muted hover:text-fg'
            )}
          >
            {item.label}
            {item.href === '/pending' ? (
              <PendingBadge count={props.pendingCount} />
            ) : null}
          </a>
        );
      })}
    </nav>
  );
}

function Account(props: { actor: string }) {
  return (
    <div class="ml-auto flex items-center gap-2">
      <a href="/add" class="btn btn-primary btn-sm">
        <Icon name="plus" />
        Add node
      </a>
      <span class="hidden items-center gap-2 text-sm text-fg-2 sm:flex">
        <span class="sr-only">Signed in as</span>
        <span class="grid size-6 place-items-center rounded-full bg-muted text-xs font-semibold uppercase text-fg-2">
          {props.actor.slice(0, 1)}
        </span>
        <span class="max-w-32 truncate">{props.actor}</span>
      </span>
      <form method="post" action="/logout">
        <button type="submit" class="btn btn-ghost btn-sm" title="Sign out">
          <Icon name="logout" />
          <span class="sr-only sm:not-sr-only">Sign out</span>
        </button>
      </form>
    </div>
  );
}

export function FlashMessage(props: { flash: Flash | null }) {
  if (props.flash === null) return null;
  const good = props.flash.kind === 'success';
  return (
    <div
      role={good ? 'status' : 'alert'}
      class={cx(
        'mb-5 flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-sm',
        good
          ? 'border-ok-dot/40 bg-ok-soft text-ok'
          : 'border-bad-dot/40 bg-bad-soft text-bad'
      )}
    >
      <Icon name={good ? 'check' : 'alert'} class="mt-0.5" />
      <p>{props.flash.text}</p>
    </div>
  );
}

/** The signed-in page frame: sticky header, navigation, flash, main landmark. */
export function Shell(props: ShellProps) {
  return (
    <>
      {raw('<!DOCTYPE html>')}
      <html lang="en">
        <Head title={props.title} />
        <body class="bg-canvas text-fg">
          <div id="admin-root">
            <noscript>
              <a
                href="#main"
                class="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-white"
              >
                Skip to content
              </a>
              <header class="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
                <div class="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 sm:px-6">
                  <Brand />
                  <Nav path={props.path} pendingCount={props.pendingCount} />
                  <Account actor={props.actor} />
                </div>
              </header>
              <main
                id="main"
                tabindex={-1}
                class="mx-auto max-w-7xl px-4 py-6 outline-none sm:px-6 sm:py-8"
              >
                <FlashMessage flash={props.flash} />
                {props.children}
              </main>
            </noscript>
          </div>
          <script type="module" src="/assets/console.js" />
        </body>
      </html>
    </>
  );
}

/** A frame without navigation, for the sign-in page. */
export function BareShell(props: { title: string; children?: Child }) {
  return (
    <>
      {raw('<!DOCTYPE html>')}
      <html lang="en">
        <Head title={props.title} />
        <body class="bg-canvas text-fg">
          <div id="admin-root">
            <noscript>
              <main
                id="main"
                class="mx-auto grid min-h-screen max-w-md content-center px-4 py-10"
              >
                {props.children}
              </main>
            </noscript>
          </div>
          <script type="module" src="/assets/console.js" />
        </body>
      </html>
    </>
  );
}

export function PageHeader(props: {
  title: string;
  subtitle?: Child;
  actions?: Child;
  back?: { href: string; label: string };
}) {
  return (
    <div class="mb-6">
      {props.back === undefined ? null : (
        <a
          href={props.back.href}
          class="mb-2 inline-flex items-center gap-1 text-sm text-fg-2 no-underline hover:text-fg"
        >
          <Icon name="chevron" class="rotate-180" />
          {props.back.label}
        </a>
      )}
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div class="min-w-0">
          <h1 class="truncate text-2xl font-semibold tracking-tight">
            {props.title}
          </h1>
          {props.subtitle === undefined ? null : (
            <div class="mt-1 text-sm text-fg-2">{props.subtitle}</div>
          )}
        </div>
        {props.actions === undefined ? null : (
          <div class="flex flex-wrap items-center gap-2">{props.actions}</div>
        )}
      </div>
    </div>
  );
}
