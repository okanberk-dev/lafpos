import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import type { Permission } from '@shared/permissions';
import { AppShell } from './components/AppShell';
import { PageLoading } from './components/ui/misc';
import { ApiError, errorMessage } from './lib/api';
import { useAuth, useCan } from './lib/auth';
import { useBootQuery } from './lib/boot';
import { homePath } from './lib/nav';
import { onLive, startLive, stopLive } from './lib/live';
import { REMOTE, REMOTE_PATHS } from './lib/remote';
import { LoginPage } from './pages/LoginPage';
import { RemoteLoginPage } from './pages/RemoteLoginPage';

const FloorPage = lazy(() => import('./pages/FloorPage'));
const OrderPage = lazy(() => import('./pages/order/OrderPage'));
const OrdersPage = lazy(() => import('./pages/OrdersPage'));
const KitchenPage = lazy(() => import('./pages/KitchenPage'));
const CashPage = lazy(() => import('./pages/cash/CashPage'));
const DevicePage = lazy(() => import('./pages/DevicePage'));
const CustomersPage = lazy(() => import('./pages/CustomersPage'));
const ReservationsPage = lazy(() => import('./pages/ReservationsPage'));
const ReportsPage = lazy(() => import('./pages/reports/ReportsPage'));
const PatronPage = lazy(() => import('./pages/patron/PatronPage'));
const AdminPage = lazy(() => import('./pages/admin/AdminPage'));
const PickupBoardPage = lazy(() => import('./pages/PickupBoardPage'));
const CustomerDisplayPage = lazy(() => import('./pages/CustomerDisplayPage'));

function Guard({ perm, children }: { perm: Permission | Permission[]; children: React.ReactNode }) {
  const can = useCan();
  const list = Array.isArray(perm) ? perm : [perm];
  if (!list.some((p) => can(p))) return <Navigate to={homePath(can)} replace />;
  return <>{children}</>;
}

function Authed() {
  const qc = useQueryClient();
  const boot = useBootQuery();
  const can = useCan();
  const location = useLocation();

  useEffect(() => {
    // Uzaktan görünümde canlı bağlantı yok: veri kafeden gelen özette, sorgular kısa aralıkla yenilenir
    if (REMOTE) return;
    startLive(qc);
    // Rol ya da kişi yetkisi değişince açık ekranın yetkileri de hemen değişsin
    const off = onLive((e) => {
      if (e.topic === 'users') void useAuth.getState().init();
    });
    return () => {
      off();
      stopLive();
    };
  }, [qc]);

  if (boot.isLoading) return <PageLoading label="LafPOS hazırlanıyor" />;
  if (boot.isError || !boot.data) {
    // Uzaktan görünümde giriş çalışır ama kafeden özet gelmemiş olabilir: ağ değil, kasa kurulumu söylenir
    const noSnapshot = REMOTE && boot.error instanceof ApiError && boot.error.code === 'no_snapshot';
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="max-w-md">
          <p className="font-semibold">{noSnapshot ? 'Kafeden henüz veri gelmedi' : 'Sunucuya bağlanılamadı'}</p>
          <p className="mt-1 text-sm text-muted">
            {noSnapshot
              ? 'Giriş çalışıyor. Kafedeki kasa bilgisayarında LafPOS 0.2.0 açılıp uzaktan erişim satırları ayarlara girilince canlı görünüm birkaç saniyede başlar'
              : REMOTE
                ? errorMessage(boot.error)
                : 'Kafedeki LafPOS bilgisayarının açık ve aynı ağda olduğundan emin olun'}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <button className="min-h-11 rounded-xl bg-primary px-4 py-2 text-primary-ink" onClick={() => boot.refetch()}>
              Tekrar dene
            </button>
            {REMOTE && (
              <button className="min-h-11 rounded-xl border border-line px-4 py-2" onClick={() => void useAuth.getState().logout()}>
                Çıkış
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (REMOTE && !REMOTE_PATHS.includes(location.pathname) && !location.pathname.startsWith('/adisyon/')) return <Navigate to="/patron" replace />;

  const demo = REMOTE && sessionStorage.getItem('lafpos.demo') === '1';
  return (
    <AppShell>
      {demo && (
        <div role="note" className="mb-3 rounded-xl border border-[var(--admin-warning)]/30 bg-[var(--admin-warning-soft)] px-3 py-2 text-sm text-[var(--admin-warning)]">
          Demo verileri: kafedeki kasa bağlanınca gerçek veriler gelir ve giriş parolası devreye girer
        </div>
      )}
      <Suspense fallback={<PageLoading />}>
        <Routes>
          <Route path="/" element={<Navigate to={homePath(can)} replace />} />
          <Route path="/masalar" element={<Guard perm="siparis.al"><FloorPage /></Guard>} />
          <Route path="/adisyon/:id" element={<Guard perm={['siparis.al', 'odeme.al']}><OrderPage /></Guard>} />
          <Route path="/siparisler" element={<Guard perm={['siparis.al', 'paket.yonet']}><OrdersPage /></Guard>} />
          <Route path="/mutfak" element={<Guard perm={['mutfak.ekran', 'siparis.al']}><KitchenPage /></Guard>} />
          <Route path="/kasa" element={<Guard perm={['kasa.gun', 'kasa.hareket', 'odeme.al', 'rapor.gor']}><CashPage /></Guard>} />
          <Route path="/cihaz" element={<Guard perm={['odeme.al', 'ayar.yonet']}><DevicePage /></Guard>} />
          <Route path="/musteriler" element={<Guard perm="cari.yonet"><CustomersPage /></Guard>} />
          <Route path="/rezervasyon" element={<Guard perm="rezervasyon.yonet"><ReservationsPage /></Guard>} />
          <Route path="/raporlar/*" element={<Guard perm="rapor.gor"><ReportsPage /></Guard>} />
          <Route path="/patron" element={<Guard perm="patron.panel"><PatronPage /></Guard>} />
          <Route path="/yonetim/*" element={<Guard perm={['menu.yonet', 'ayar.yonet', 'personel.yonet', 'senkron.yonet', 'stok.yonet']}><AdminPage /></Guard>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

export function App() {
  const { me, ready, init } = useAuth();
  const location = useLocation();

  useEffect(() => {
    init();
  }, [init]);

  // Müşteriye dönük ekranlar (çağrı, müşteri ekranı) personel girişi istemez: tablette ya da televizyonda kimsenin
  // oturumu açık kalmaz; kasa menüsü ve otomatik kilit yok. Uzaktan görünümde yoklar
  if (!REMOTE && (location.pathname === '/cagri' || location.pathname === '/musteri-ekrani')) {
    return <Suspense fallback={<PageLoading />}>{location.pathname === '/cagri' ? <PickupBoardPage /> : <CustomerDisplayPage />}</Suspense>;
  }
  if (!ready) return <PageLoading label="LafPOS açılıyor" />;
  if (!me) {
    if (location.pathname !== '/giris') return <Navigate to="/giris" replace state={{ from: location.pathname }} />;
    return REMOTE ? <RemoteLoginPage /> : <LoginPage />;
  }
  if (location.pathname === '/giris') return <Navigate to="/" replace />;
  return <Authed />;
}
