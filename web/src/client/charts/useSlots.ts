import { useRef } from 'react';
import { SlotAssigner } from './palette.ts';

/** One SlotAssigner per page mount: the page's charts agree on series colors. */
export function useSlots(): SlotAssigner {
  const ref = useRef<SlotAssigner | null>(null);
  ref.current ??= new SlotAssigner();
  return ref.current;
}
