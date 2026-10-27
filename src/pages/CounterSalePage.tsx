import { Store, Wallet } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/Button';
import { EmptyState, PageLoading } from '@/components/ui/misc';
import { errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { openCounterSale } from '@/lib/counter';

/**
 * Yeni satış (self ve yarı self servisin açılış ekranı, menüde "Satış"): bu cihazın boş tezgâh adisyonunu açar
 * ya da yeniden kullanır ve doğrudan adisyona geçer. Gün açılmamışsa kasaya yönlendiren boş durum.
 */
export default function CounterSalePage() {
  const boot = useBoot();
  const can = useCan();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const started = useRef(-1);

  useEffect(() => {
    // Geliştirmede efekt iki kez çalışır; aynı deneme için tek adisyon açılsın
    if (!boot.day || started.current === attempt) return;
    started.current = attempt;
    openCounterSale()
      .then((o) => navigate(`/adisyon/${o.id}`, { replace: true }))
      .catch((e) => setError(errorMessage(e)));
  }, [boot.day, attempt, navigate]);

  if (!boot.day) {
    return (
      <div className="grid h-full place-items-center p-4">
        <EmptyState
          icon={<Wallet />}
          title="Gün açılmamış"
          action={
            can('kasa.gun') ? (
              <Button variant="primary" size="lg" onClick={() => navigate('/kasa')}>
                Kasaya git ve günü aç
              </Button>
            ) : undefined
          }
        >
          {can('kasa.gun') ? 'Satışa başlamak için önce günü açın' : 'Satışa başlamak için yetkili birinin günü açması gerekiyor'}
        </EmptyState>
      </div>
    );
  }

  if (error) {
    return (
      <div className="grid h-full place-items-center p-4">
        <EmptyState
          icon={<Store />}
          title="Yeni satış açılamadı"
          action={
            <Button
              variant="primary"
              size="lg"
              onClick={() => {
                setError(null);
                setAttempt((n) => n + 1);
              }}
            >
              Tekrar dene
            </Button>
          }
        >
          {error}
        </EmptyState>
      </div>
    );
  }

  return <PageLoading label="Yeni satış açılıyor" />;
}
