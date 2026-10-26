import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import type { Permission } from '@shared/permissions';
import { AppShell } from './components/AppShell';
import { PageLoading } from './components/ui/misc';
import { useAuth, useCan } from './lib/auth';
import { useBootQuery } from './lib/boot';
import { homePath } from './lib/nav';
import { startLive, stopLive } from './lib/live';
import { LoginPage } from './pages/LoginPage';

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

  useEffect(() => {
    startLive(qc);
    return () => stopLive();
  }, [qc]);

  if (boot.isLoading) return <PageLoading label="LafPOS hazırlanıyor" />;
  if (boot.isError || !boot.data) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <p className="font-semibold">Sunucuya bağlanılamadı</p>
          <p className="mt-1 text-sm text-muted">Kafedeki LafPOS bilgisayarının açık ve aynı ağda olduğundan emin olun</p>
          <button className="mt-4 rounded-xl bg-primary px-4 py-2 text-primary-ink" onClick={() => boot.refetch()}>
            Tekrar dene
          </button>
        </div>
      </div>
    );
  }

  return (
    <AppShell>
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

  if (!ready) return <PageLoading label="LafPOS açılıyor" />;
  if (!me) {
    if (location.pathname !== '/giris') return <Navigate to="/giris" replace state={{ from: location.pathname }} />;
    return <LoginPage />;
  }
  if (location.pathname === '/giris') return <Navigate to="/" replace />;
  return <Authed />;
}
