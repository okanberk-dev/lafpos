import { AnimatePresence, motion, type Transition, useReducedMotion } from 'motion/react';
import { Fragment, type KeyboardEvent, useId, useMemo, useState } from 'react';
import { LafTile } from '@/components/LafMark';
import { SearchInput } from '@/components/ui/Field';
import { Card, EmptyState } from '@/components/ui/misc';
import { Stage } from '@/components/ui/Stage';
import { useAuth } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { answerParts, answerText, FAQ_GROUPS, type FaqItem, faqFor } from '@/lib/faq';
import { useBarEnabled } from '@/lib/serviceMode';
import { fold } from '@/lib/shell';

/**
 * Sık sorulan sorular (`/yardim`; Araçlar çekmecesi ve komut paleti açar). Sorular sohbet gibi (rare-ui FAQ'sundan
 * uyarlandı): solda soru balonu, dokununca sağda L'Af karosunun yanında yanıt balonu açılır, alttakiler yumuşakça kayar.
 * Uyarlama: renkler Keel belirteçlerinden (soru kuyuda, açık soru beyaz ve saç telli, yanıt Keel'in mürekkep kartı gibi:
 * açıkta mürekkep zemin beyaz yazı, gecede tersi), marka yalnız L'Af karosunda; balon en az 44 px; ok tuşları, Home ve
 * End sorular arasında gezer; hareket azaltmada her şey anında. Ekrandaki adlar yanıtın içinde etiket gibi çizilir.
 * İçerik ve rol kuralı `src/lib/faq.ts`'te: kişi yalnız kendi işinin sorularını görür.
 */

const SEND: Transition = { type: 'spring', visualDuration: 0.38, bounce: 0.22 };
const SHIFT: Transition = { type: 'spring', visualDuration: 0.36, bounce: 0.08 };
const LEAVE: Transition = { duration: 0.16, ease: [0.4, 0, 1, 1] };
const INSTANT: Transition = { duration: 0 };

const QUESTION = '[data-slot="faq-question"]';
const KEY_STEPS: Record<string, (index: number, last: number) => number> = {
  ArrowDown: (i) => i + 1,
  ArrowUp: (i) => i - 1,
  Home: () => 0,
  End: (_, last) => last,
};

/** Yanıt: düz yazı ve ekranın adları (etiket; yol `›` ile) */
function Answer({ text }: { text: string }) {
  return (
    <>
      {answerParts(text).map((p, i) =>
        'text' in p ? (
          <Fragment key={i}>{p.text}</Fragment>
        ) : (
          <span key={i} className="rounded-[6px] bg-[color-mix(in_oklab,var(--k-on-select)_14%,transparent)] px-1 py-px font-semibold [box-decoration-break:clone] [-webkit-box-decoration-break:clone]">
            {p.label.join(' › ')}
          </span>
        ),
      )}
    </>
  );
}

function Bubble({ item, uid, openId, reduced, onToggle }: { item: FaqItem; uid: string; openId: string | null; reduced: boolean; onToggle: () => void }) {
  const open = openId === item.id;
  const ids = { question: `${uid}-${item.id}-soru`, answer: `${uid}-${item.id}-yanit` };
  return (
    <>
      <motion.button
        id={ids.question}
        type="button"
        data-slot="faq-question"
        aria-expanded={open}
        aria-controls={open ? ids.answer : undefined}
        onClick={onToggle}
        // Bir yanıt açılınca her balon yerini yeniden ölçer: alttakiler kayar
        layout="position"
        layoutDependency={openId}
        transition={reduced ? INSTANT : SHIFT}
        whileTap={reduced ? undefined : { scale: 0.97 }}
        className={cn(
          'min-h-11 max-w-[88%] self-start rounded-[18px] rounded-bl-[6px] px-4 py-2.5 text-left text-[15px] leading-[1.4] tracking-[-0.01em] text-ink transition-colors duration-150 sm:max-w-[85%]',
          open ? 'bg-surface font-medium ring-1 ring-inset ring-[var(--k-line-strong)]' : 'bg-[var(--k-well)] hover:bg-[var(--k-well-2)]',
        )}
      >
        {item.question}
      </motion.button>
      <AnimatePresence mode="popLayout" initial={false}>
        {open && (
          <motion.div
            key="yanit"
            layout="position"
            layoutDependency={openId}
            initial={{ opacity: 0, scale: 0.6, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, transition: reduced ? INSTANT : LEAVE }}
            transition={reduced ? INSTANT : SEND}
            style={{ originX: 1, originY: 1 }}
            className="flex items-end justify-end gap-2"
          >
            <div
              id={ids.answer}
              role="region"
              aria-labelledby={ids.question}
              className="max-w-[88%] rounded-[18px] rounded-br-[6px] bg-[var(--k-select)] px-4 py-2.5 text-[15px] leading-[1.5] tracking-[-0.01em] text-[var(--k-on-select)] sm:max-w-[85%]"
            >
              <Answer text={item.answer} />
            </div>
            {/* Karo uygulama ikonunun biçiminde (DESIGN.md: arayüzün köşe ölçeğine uymaz) */}
            <LafTile size="sm" />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export default function HelpPage() {
  const perms = useAuth((s) => s.me?.permissions);
  const tips = useBoot().settings.tipsEnabled;
  const bar = useBarEnabled();
  const reduced = useReducedMotion() ?? false;
  const uid = useId();
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const items = useMemo(() => faqFor({ can: (p) => !!perms?.includes(p), tips, bar }), [perms, tips, bar]);
  const needle = fold(q.trim());
  const shown = needle ? items.filter((i) => fold(`${i.question} ${answerText(i.answer)}`).includes(needle)) : items;
  const groups = FAQ_GROUPS.map((g) => ({ ...g, items: shown.filter((i) => i.group === g.key) })).filter((g) => g.items.length);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = KEY_STEPS[e.key];
    const target = e.target as HTMLElement;
    if (!step || !target.matches(QUESTION)) return;
    const questions = [...e.currentTarget.querySelectorAll<HTMLElement>(QUESTION)];
    const next = step(questions.indexOf(target), questions.length - 1);
    e.preventDefault();
    questions[(next + questions.length) % questions.length]?.focus();
  };

  return (
    <Stage name="Sık sorulan sorular" sub="Kasada ve yönetimde en çok sorulanlar; yanıtta ekrandaki düğmenin adı yazar" leafLabel="Sık sorulan sorular" float>
      <div className="lp-leaf-pad">
        <div className="mx-auto max-w-[1180px]">
          <div className="mb-3 max-w-md">
            <SearchInput value={q} onChange={setQ} label="Sorularda ara" placeholder="Sorularda ara" />
          </div>
          {/* Arama sonucu ekran okuyucuya söylenir */}
          <p className="sr-only" role="status" aria-live="polite">
            {needle ? (shown.length ? `${shown.length} soru bulundu` : 'Soru bulunamadı') : ''}
          </p>
          {groups.length === 0 ? (
            <EmptyState art="arama" title="Bu aramayla soru yok" className="rounded-[var(--r-card)] bg-surface">
              Başka bir kelime deneyin ya da aramayı temizleyin
            </EmptyState>
          ) : (
            <div onKeyDown={onKeyDown} className="grid items-start gap-3 lg:grid-cols-2">
              {groups.map((g) => (
                <Card key={g.key} title={g.label} divided={false} actions={<span className="tabular text-[13px] text-muted">{g.items.length} soru</span>}>
                  <div className="flex flex-col gap-2.5 px-4 pb-5 pt-2 sm:px-5">
                    {g.items.map((item) => (
                      <Bubble key={item.id} item={item} uid={uid} openId={openId} reduced={reduced} onToggle={() => setOpenId((cur) => (cur === item.id ? null : item.id))} />
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </Stage>
  );
}
