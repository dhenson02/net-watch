// A minimal client-side router. The server already serves index.html for
// every non-API path, so no router dependency is needed. All page state lives
// in the URL (path + query), so every view can be linked and bookmarked.
import { createElement, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

const subscribe = (onChange: () => void) => {
  addEventListener('popstate', onChange);
  return () => removeEventListener('popstate', onChange);
};

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => location.pathname);
}

export function useSearch(): string {
  return useSyncExternalStore(subscribe, () => location.search);
}

/** Changes the URL and notifies usePath/useSearch subscribers. */
export function navigate(url: string, opts: { replace?: boolean } = {}): void {
  if (url === location.pathname + location.search + location.hash) return;
  if (opts.replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  dispatchEvent(new PopStateEvent('popstate'));
}

/**
 * Sets or removes (null) query parameters, keeping the others. Pushes a
 * history entry unless `replace`; use replace for high-frequency tweaks.
 */
export function setSearchParams(patch: Record<string, string | number | null>, opts: { replace?: boolean } = {}): void {
  const params = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) params.delete(k);
    else params.set(k, String(v));
  }
  const qs = params.toString();
  navigate(location.pathname + (qs ? `?${qs}` : ''), opts);
}

/** One query parameter as state. Setting it to the default removes it from the URL. */
export function useSearchParam(name: string, fallback: string): [string, (value: string, opts?: { replace?: boolean }) => void] {
  const value = new URLSearchParams(useSearch()).get(name) ?? fallback;
  const set = (v: string, opts?: { replace?: boolean }) => setSearchParams({ [name]: v === fallback ? null : v }, opts);
  return [value, set];
}

/**
 * Matches `path` against a pattern like `/process/:pid/:start`. Returns the
 * decoded params, or null when it does not match.
 */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = path.replace(/\/+$/, '').split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    const g = got[i]!;
    if (w.startsWith(':')) {
      if (!g) return null;
      params[w.slice(1)] = decodeURIComponent(g);
    } else if (w !== g) {
      return null;
    }
  }
  return params;
}

/**
 * An `<a href>` that navigates in-app on a plain left click, so middle-click,
 * ctrl/cmd-click and "copy link" still behave like a normal link.
 */
export function Link(props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    props.onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || props.target) return;
    e.preventDefault();
    navigate(props.href);
  };
  return createElement('a', { ...props, onClick });
}
