import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect } from 'react';
import { Button, buttonClass } from './components/ui/Button';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router';
import type { Permission } from '@shared/permissions';
import { AppShell } from './components/AppShell';
import { ADMIN_ROUTE_PERMS } from './components/admin/sections';
import { ErrorState, Notice, PageLoading } from './components/ui/misc';
import { ApiError, errorMessage } from './lib/api';
import { useAuth, useCan } from './lib/auth';
import { useBootQuery } from './lib/boot';
import { DOWNLOAD_PATH } from './lib/download';
import { useHomePath } from './lib/serviceMode';
import { onLive, startLive, stopLive } from './lib/live';
import { REMOTE, REMOTE_PATHS, useRemoteSignOut } from './lib/remote';
import { isBootDarkPath, useTheme } from './lib/theme';
import { DemoRolePicker } from './demo/DemoRolePicker';
import { DEMO } from './lib/demo';
import { LoginPage } from './pages/LoginPage';
import { RemoteLoginPage } from './pages/RemoteLoginPage';

const FloorPage = lazy(() => import('./pages/FloorPage'));
const CounterSalePage = lazy(() => import('./pages/CounterSalePage'));
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
const DownloadPage = lazy(() => import('./pages/DownloadPage'));
const StandaloneDownloadPage = lazy(() => import('./pages/DownloadPage').then((m) => ({ default: m.StandaloneDownloadPage })));

function Guard({ perm, children }: { perm: Permission | Permission[]; children: React.ReactNode }) {
  const can = useCan();
  const home = useHomePath();
  const list = Array.isArray(perm) ? perm : [perm];
  if (!list.some((p) => can(p))) return <Navigate to={home} replace />;
  return <>{children}</>;
}

function Authed() {
  const qc = useQueryClient();
  const boot = useBootQuery();
  const home = useHomePath();
  const location = useLocation();
  const remoteSignOut = useRemoteSignOut();

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

  if (boot.isLoading) return <PageLoading label="LafPOS açılıyor…" />;
  // Uzaktan İndir kafeden veri beklemez: program henüz kurulmadıysa özet de yoktur (kabuksuz aynı sayfa)
  if (REMOTE && location.pathname === DOWNLOAD_PATH && (boot.isError || !boot.data)) {
    return (
      <Suspense fallback={<PageLoading />}>
        <StandaloneDownloadPage />
      </Suspense>
    );
  }
  if (boot.isError || !boot.data) {
    // Uzaktan görünümde giriş çalışır ama kafeden özet gelmemiş olabilir: ağ değil, kasa kurulumu söylenir
    const noSnapshot = REMOTE && boot.error instanceof ApiError && boot.error.code === 'no_snapshot';
    return (
      <div className="grid h-full place-items-center p-6">
        {/* Tam ekran durum: büyük boy, Yeniden dene ve Çıkış aynı boyda. Uzaktan giriş parola sormadan giriyorsa Çıkış
            yok: aynı oturum hemen yeniden açılıp bu ekrana dönerdi, Yeniden dene yeter */}
        <ErrorState
          large
          title={noSnapshot ? 'Kafeden henüz veri gelmedi' : 'Sunucuya bağlanılamadı'}
          error={boot.error}
          onRetry={() => void boot.refetch()}
          retrying={boot.isFetching}
          action={
            <>
              {/* Program henüz kurulmadıysa özet de yoktur: indirme sayfası buradan açılır */}
              {noSnapshot && (
                <Link to={DOWNLOAD_PATH} className={buttonClass('secondary', 'md')}>
                  Programı indir
                </Link>
              )}
              {remoteSignOut && (
                <Button size="md" variant="ghost" onClick={() => void useAuth.getState().logout()}>
                  Çıkış
                </Button>
              )}
            </>
          }
        >
          {noSnapshot
            ? 'Giriş çalışıyor. Kafedeki kasa bilgisayarında LafPOS açılıp uzaktan erişim satırları ayarlara girilince canlı görünüm birkaç saniyede başlar'
            : REMOTE
              ? errorMessage(boot.error)
              : 'Kafedeki LafPOS bilgisayarının açık ve aynı ağda olduğundan emin olun'}
        </ErrorState>
      </div>
    );
  }

  if (REMOTE && !REMOTE_PATHS.includes(location.pathname) && !location.pathname.startsWith('/adisyon/')) return <Navigate to="/patron" replace />;

  const demo = REMOTE && sessionStorage.getItem('lafpos.demo') === '1';
  return (
    // Uzaktan görünümün demo notu kabuğun şeridinde, sayfanın dışında: sayfa main'in tam yüksekliğini kullanır, içeride
    // dursa her ekranın altını keserdi. Uyarı değil bilgi
    <AppShell
      notice={
        demo && (
          <Notice
            tone="info"
            role="note"
            className="rounded-none border-x-0 border-t-0 md:mb-2 md:rounded-xl md:border"
            action={
              <a href="/demo/" className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-2 pointer-fine:min-h-0">
                Kasa ekranını dene
              </a>
            }
          >
            Demo verileri: kafedeki kasa bağlanınca gerçek veriler gelir
          </Notice>
        )
      }
    >
      <Suspense fallback={<PageLoading />}>
        <Routes>
          <Route path="/" element={<Navigate to={home} replace />} />
          <Route path="/masalar" element={<Guard perm="siparis.al"><FloorPage /></Guard>} />
          <Route path="/satis" element={<Guard perm="siparis.al"><CounterSalePage /></Guard>} />
          <Route path="/adisyon/:id" element={<Guard perm={['siparis.al', 'odeme.al']}><OrderPage /></Guard>} />
          <Route path="/siparisler" element={<Guard perm={['siparis.al', 'paket.yonet']}><OrdersPage /></Guard>} />
          <Route path="/mutfak" element={<Guard perm={['mutfak.ekran', 'siparis.al']}><KitchenPage /></Guard>} />
          <Route path="/kasa" element={<Guard perm={['kasa.gun', 'kasa.hareket', 'odeme.al', 'rapor.gor']}><CashPage /></Guard>} />
          <Route path="/cihaz" element={<Guard perm={['odeme.al', 'ayar.yonet']}><DevicePage /></Guard>} />
          <Route path="/musteriler" element={<Guard perm="cari.yonet"><CustomersPage /></Guard>} />
          <Route path="/rezervasyon" element={<Guard perm="rezervasyon.yonet"><ReservationsPage /></Guard>} />
          <Route path="/raporlar/*" element={<Guard perm="rapor.gor"><ReportsPage /></Guard>} />
          <Route path="/patron" element={<Guard perm="patron.panel"><PatronPage /></Guard>} />
          {/* Siteden kurulum: yalnız LafPOS Uzaktan'da ve girişten sonra (kasada program zaten kurulu) */}
          {REMOTE && <Route path={DOWNLOAD_PATH} element={<DownloadPage />} />}
          {/* Bölümlerden birini açabilen girer (patron paneli Denetim kaydına, raporcu Genel bakışa); bölümün izni AdminPage'de */}
          <Route path="/yonetim/*" element={<Guard perm={ADMIN_ROUTE_PERMS}><AdminPage /></Guard>} />
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

  // Açılıştaki bar ekranı koyusu (main.tsx initTheme) adres oradan çıkınca bırakılır: giriş ya da yetki
  // yönlendirmesi başka ekrana götürdüyse o ekran temasıyla açılır. Bar ekranı açıkken kendi koyusunu tutar
  useEffect(() => {
    if (!isBootDarkPath(location.pathname) && location.pathname !== '/giris') useTheme.getState().releaseBootDark();
  }, [location.pathname]);

  // Müşteriye dönük ekranlar (çağrı, müşteri ekranı) personel girişi istemez: tablette ya da televizyonda kimsenin
  // oturumu açık kalmaz; kasa menüsü ve otomatik kilit yok. Uzaktan görünümde yoklar
  if (!REMOTE && (location.pathname === '/cagri' || location.pathname === '/musteri-ekrani')) {
    return <Suspense fallback={<PageLoading />}>{location.pathname === '/cagri' ? <PickupBoardPage /> : <CustomerDisplayPage />}</Suspense>;
  }
  if (!ready) return <PageLoading label="LafPOS açılıyor…" />;
  if (!me) {
    if (location.pathname !== '/giris') return <Navigate to="/giris" replace state={{ from: location.pathname }} />;
    return REMOTE ? <RemoteLoginPage /> : DEMO ? <DemoRolePicker /> : <LoginPage />;
  }
  if (location.pathname === '/giris') return <Navigate to="/" replace />;
  return <Authed />;
}
