import { groupTyped } from '@/lib/numpad';

/** Tuş takımıyla yazılmakta olan tutar: ₺ başta, sönük ve küçük; metin groupTyped ile (src/lib/numpad.ts) */
export function TypedAmount({ text }: { text: string }) {
  return (
    <>
      <span className="mr-1 align-baseline text-[0.6em] font-medium text-muted">₺</span>
      {groupTyped(text)}
    </>
  );
}
