import { useSyncExternalStore } from 'react';
export function navigate(href: string, confirmed = false) {
  const event = new CustomEvent('fleet:before-navigate', {
    cancelable: true,
    detail: href,
  });
  if (!confirmed && !window.dispatchEvent(event)) return;
  history.pushState(null, '', href);
  window.dispatchEvent(new Event('fleet:navigate'));
}
function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener);
  window.addEventListener('fleet:navigate', listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener('fleet:navigate', listener);
  };
}
export function useLocation() {
  return useSyncExternalStore(
    subscribe,
    () => location.pathname + location.search
  );
}
export function installNavigation() {
  document.addEventListener('click', (event) => {
    if (modifiedClick(event)) return;
    const link =
      event.target instanceof Element
        ? event.target.closest<HTMLAnchorElement>('a[href]')
        : null;
    if (
      !link ||
      link.target ||
      link.download ||
      link.getAttribute('href')?.startsWith('#')
    )
      return;
    const url = new URL(link.href);
    if (
      url.origin !== location.origin ||
      !/^\/(?:nodes(?:\/[a-f0-9]{64})?|settings(?:\/[^/]+)?|pending|events|add|access)?$/.test(
        url.pathname
      )
    )
      return;
    event.preventDefault();
    navigate(url.pathname + url.search);
  });
}

function modifiedClick(event: MouseEvent) {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}
