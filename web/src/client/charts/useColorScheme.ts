import { useSyncExternalStore } from 'react';
import type { Scheme } from './palette.ts';

const query = matchMedia('(prefers-color-scheme: dark)');

const subscribe = (onChange: () => void) => {
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

/** The OS color scheme, updated live. */
export function useColorScheme(): Scheme {
  return useSyncExternalStore(subscribe, () => (query.matches ? 'dark' : 'light'));
}
