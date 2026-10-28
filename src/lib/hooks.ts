import { useEffect, useState } from 'react';

/** Belirli aralıkla yeniden çizim (süre göstergeleri için) */
export function useTick(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener('change', on);
    on();
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** Birincil giriş fare mi (tıklama), dokunmatik değil mi; anlık değer (çizimde değil, olayda okunur) */
export function isFinePointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches;
}

/**
 * Fareli cihaz mı. `autoFocus={useFinePointer()}`: bilgisayarda pencere açılınca alan odaklı gelir; telefonda ve
 * tablette odaklanmaz, ekran klavyesi alt sayfayı örtmez (kasiyer önce okur, sonra dokunur)
 */
export function useFinePointer(): boolean {
  return useMediaQuery('(pointer: fine)');
}

/**
 * Değer `ms` boyunca değişmeden durunca true (kısa yüklemede gösterge yanıp sönmesin):
 * `const slow = useDelayed(q.isPending, 300)`
 */
export function useDelayed(active: boolean, ms = 300): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) {
      setOn(false);
      return;
    }
    const t = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return active && on;
}

/** Tarayıcıda saklanan küçük tercih (sekme, görünüm). Saklanamazsa bellekte kalır. */
export function useLocalPref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => readLocalPref(key, initial));
  const set = (v: T) => {
    setValue(v);
    writeLocalPref(key, v);
  };
  return [value, set];
}

/** `useLocalPref`'in tercihini bileşen dışından yazar (bar ekranı teması gibi) */
export function writeLocalPref<T>(key: string, v: T) {
  try {
    localStorage.setItem(`lafpos.pref.${key}`, JSON.stringify(v));
  } catch {
    /* özel pencere */
  }
}

/** `useLocalPref`'in kaydettiği değeri bileşen dışından okur (açılışta tema gibi) */
export function readLocalPref<T>(key: string, initial: T): T {
  try {
    const raw = localStorage.getItem(`lafpos.pref.${key}`);
    return raw ? (JSON.parse(raw) as T) : initial;
  } catch {
    return initial;
  }
}
