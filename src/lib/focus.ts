import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * Pencere ve çekmecelerin ortak odak kuralları (Modal, QuickLook, komut paleti, onay penceresi, tuş takımı):
 * Tab pencereden dışarı kaçmaz, Escape ve klavye girişi yalnız en üstteki pencereye gider.
 */

const FOCUSABLE = 'a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && !el.closest('[inert]') && el.getClientRects().length > 0);
}

/**
 * Tab'ı pencerenin içinde döndürür: sondan başa, Shift+Tab'da baştan sona. Portaldaki iç pencereden kabarcıklanan
 * olayı (React ağacında üst pencereye de ulaşır) yalnız DOM'da içeren pencere işler.
 */
export function trapTab(e: ReactKeyboardEvent, root: HTMLElement | null) {
  if (e.key !== 'Tab' || !root || !root.contains(e.target as Node)) return;
  const items = focusables(root);
  if (!items.length) {
    e.preventDefault();
    root.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === root)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/** Açık kipli pencerelerin en üstteki (DOM'da en son eklenen) */
export function topDialog(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
  return all.length ? all[all.length - 1] : null;
}

/** Öğe en üst katmanda mı: açık pencere yoksa pencere dışında, varsa en üstteki pencerenin içinde */
export function isTopLayer(el: Element | null): boolean {
  if (!el) return false;
  const top = topDialog();
  return top ? top.contains(el) : !el.closest('[role="dialog"]');
}

/** Klavye olayının hedefi yazı alanı mı (o zaman sayfa kısayolları ve tuş takımı dinleyicisi devreye girmez) */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(target.type);
  return false;
}
