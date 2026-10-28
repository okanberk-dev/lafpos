import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { create } from 'zustand';
import { useFinePointer } from '@/lib/hooks';
import { onSessionEnd } from '@/lib/sessionEnd';
import { Button } from './Button';
import { Field, Input, Textarea } from './Field';
import { Modal } from './Modal';

/**
 * Tarayıcının `window.confirm` / `window.prompt` pencerelerinin yerine (tasarım dışı, koyu temada beyaz,
 * dokunmatikte küçük, düğmeleri "OK / Cancel"). Telefonda alt sayfa, geniş ekranda küçük pencere. Düğmeler
 * eylemi adlandırır ("Masayı kaldır", "Kodu yenile"); yıkıcı eylemde kırmızı düğme ve odak "Vazgeç"te.
 *
 *   if (!(await confirmDialog({ title: `${t.name} plandan kaldırılsın mı`, body: 'Geçmiş adisyonlar değişmez', confirmLabel: 'Masayı kaldır' }))) return;
 *   const reason = await promptDialog({ title: 'Ödeme iptali', label: 'Neden', placeholder: 'Ör. yanlış tutar girildi', confirmLabel: 'Ödemeyi iptal et', required: true });
 *   if (reason == null) return;
 *
 * Başlıkta sonda noktalama yok (soru da olsa). `ConfirmHost` main.tsx'te bir kez çizilir.
 */
export interface ConfirmOptions {
  title: ReactNode;
  body?: ReactNode;
  /** Eylemi adlandıran düğme metni (fiil + nesne) */
  confirmLabel: string;
  cancelLabel?: string;
  /** danger (varsayılan): kırmızı düğme, odak Vazgeç'te; primary: mavi düğme, odak onayda */
  tone?: 'danger' | 'primary';
}

export interface PromptOptions extends ConfirmOptions {
  /** Alanın etiketi ("Neden", "Bölüm adı") */
  label: string;
  placeholder?: string;
  hint?: ReactNode;
  initial?: string;
  /** Boş geçilemez; metin verilirse boşken o ileti gösterilir */
  required?: boolean | string;
  multiline?: boolean;
  inputMode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email';
  maxLength?: number;
  /** Gönderilmeden önce denetim: ileti döndürürse alanın altında gösterilir, pencere açık kalır */
  validate?: (value: string) => string | null;
}

type Pending = { id: number } & (
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void }
);

let seq = 0;

const useConfirmStore = create<{ pending: Pending | null }>(() => ({ pending: null }));

function open(next: Pending) {
  // Açıkken yenisi gelirse öncekinden vazgeçilmiş sayılır
  const prev = useConfirmStore.getState().pending;
  if (prev) {
    if (prev.kind === 'confirm') prev.resolve(false);
    else prev.resolve(null);
  }
  useConfirmStore.setState({ pending: next });
}

/** Açık soru vazgeçilmiş sayılır (oturum kapandı: kilit, çıkış): onay false, metin null döner, pencere kapanır */
export function cancelDialogs() {
  const prev = useConfirmStore.getState().pending;
  if (!prev) return;
  useConfirmStore.setState({ pending: null });
  if (prev.kind === 'confirm') prev.resolve(false);
  else prev.resolve(null);
}

onSessionEnd(cancelDialogs);

/** Onay sorar; "evet" için true, vazgeçince false */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => open({ id: ++seq, kind: 'confirm', options, resolve }));
}

/** Kısa metin ister (neden, ad, tutar); vazgeçince null, girilen metin kırpılmış döner */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => open({ id: ++seq, kind: 'prompt', options, resolve }));
}

/** Bileşen içinde: `const { confirm, prompt } = useConfirm()` (aynı işlevler; kanca kurmaz, yalnız okunaklılık) */
export function useConfirm() {
  return { confirm: confirmDialog, prompt: promptDialog };
}

export function ConfirmHost() {
  const pending = useConfirmStore((s) => s.pending);
  if (!pending) return null;
  // Her soru kendi örneği: önceki yazı ve hata taşınmaz
  return <ConfirmDialog key={pending.id} pending={pending} />;
}

function ConfirmDialog({ pending }: { pending: Pending }) {
  const fine = useFinePointer();
  const o = pending.options;
  const tone = o.tone ?? 'danger';
  const prompt = pending.kind === 'prompt' ? pending.options : null;
  const [value, setValue] = useState(prompt?.initial ?? '');
  const [error, setError] = useState<string | null>(null);
  const formId = useId();

  const close = (result: boolean | string | null) => {
    useConfirmStore.setState({ pending: null });
    if (pending.kind === 'confirm') pending.resolve(result === true);
    else pending.resolve(typeof result === 'string' ? result : null);
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!prompt) return close(true);
    const v = value.trim();
    if (prompt.required && !v) {
      setError(typeof prompt.required === 'string' ? prompt.required : `${prompt.label} gerekli`);
      return;
    }
    const msg = prompt.validate?.(v) ?? null;
    if (msg) {
      setError(msg);
      return;
    }
    close(v);
  };

  const footer = (
    <div className="grid grid-cols-2 gap-2">
      <Button autoFocus={!prompt && tone === 'danger'} onClick={() => close(null)}>
        {o.cancelLabel ?? 'Vazgeç'}
      </Button>
      <Button type="submit" form={formId} variant={tone === 'danger' ? 'danger' : 'primary'} autoFocus={!prompt && tone === 'primary'} className="whitespace-normal leading-tight">
        {o.confirmLabel}
      </Button>
    </div>
  );

  return (
    <Modal open size="sm" title={o.title} onClose={() => close(null)} footer={footer}>
      <form id={formId} onSubmit={submit} className="space-y-3 px-5 py-4" noValidate>
        {o.body && <div className="text-pretty text-sm leading-relaxed text-ink-2">{o.body}</div>}
        {prompt && (
          <Field label={prompt.label} hint={prompt.hint} required={!!prompt.required} error={error}>
            {prompt.multiline ? (
              <Textarea
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
                placeholder={prompt.placeholder}
                maxLength={prompt.maxLength}
                autoFocus={fine}
                rows={3}
              />
            ) : (
              <Input
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
                placeholder={prompt.placeholder}
                maxLength={prompt.maxLength}
                inputMode={prompt.inputMode}
                enterKeyHint="done"
                autoFocus={fine}
              />
            )}
          </Field>
        )}
      </form>
    </Modal>
  );
}
