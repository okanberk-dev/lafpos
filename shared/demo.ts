/** Tarayıcı demosu (Uzaktan'ın `/demo` yolu): arayüzle demo çalışma zamanı (demo/runtime.ts) arasındaki sözleşme */

/** Demoda girilebilen örnek personel. PIN ekranda görünmez; rol seçilince demo kendisi girer */
export interface DemoUser {
  role: string;
  name: string;
  color: string;
  pin: string;
}

export interface DemoServer {
  users: DemoUser[];
  /** Veri tarayıcıda kalıcı mı (özel pencerede IndexedDB yoksa yalnız bu sekmede) */
  persistent: boolean;
  /** Demo verisini siler; sayfa yeniden yüklenince ilk günden başlar */
  reset: () => Promise<void>;
}
