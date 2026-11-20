import { ChevronRight } from 'lucide-react';
import { lazy, type ReactNode, Suspense } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router';
import { AdminShell } from '@/components/admin/AdminShell';
import { ADMIN_GROUPS, ADMIN_SECTIONS, visibleSections } from '@/components/admin/sections';
import { CARD, IconBox, PageHeader } from '@/components/admin/ui';
import { PageLoading } from '@/components/ui/misc';
import { useCan } from '@/lib/auth';
import { useMediaQuery } from '@/lib/hooks';

const OverviewAdmin = lazy(() => import('./OverviewAdmin'));
const MenuAdmin = lazy(() => import('./MenuAdmin'));
const OptionsAdmin = lazy(() => import('./OptionsAdmin'));
const FloorAdmin = lazy(() => import('./FloorAdmin'));
const UsersAdmin = lazy(() => import('./UsersAdmin'));
const RolesAdmin = lazy(() => import('./RolesAdmin'));
const SettingsAdmin = lazy(() => import('./SettingsAdmin'));
const PaymentsAdmin = lazy(() => import('./PaymentsAdmin'));
const OkcAdmin = lazy(() => import('./OkcAdmin'));
const IntegrationAdmin = lazy(() => import('./IntegrationAdmin'));
const PlatformsAdmin = lazy(() => import('./PlatformsAdmin'));
const NetworkAdmin = lazy(() => import('./NetworkAdmin'));
const AuditAdmin = lazy(() => import('./AuditAdmin'));
const DisplayAdmin = lazy(() => import('./DisplayAdmin'));

const PAGES: Record<string, ReactNode> = {
  genel: <OverviewAdmin />,
  menu: <MenuAdmin />,
  secenekler: <OptionsAdmin />,
  'masa-plani': <FloorAdmin />,
  'musteri-ekrani': <DisplayAdmin />,
  personel: <UsersAdmin />,
  roller: <RolesAdmin />,
  odeme: <PaymentsAdmin />,
  yazarkasa: <OkcAdmin />,
  entegrasyon: <IntegrationAdmin />,
  platformlar: <PlatformsAdmin />,
  ag: <NetworkAdmin />,
  ayarlar: <SettingsAdmin />,
  denetim: <AuditAdmin />,
};

/** Bölümün izni yoksa yönetim listesine döner (asıl denetim sunucuda) */
function SectionRoute({ sectionKey }: { sectionKey: string }) {
  const can = useCan();
  const section = ADMIN_SECTIONS.find((s) => s.key === sectionKey)!;
  if (!section.perm.some((p) => can(p))) return <Navigate to="/yonetim" replace />;
  return <>{PAGES[sectionKey]}</>;
}

/**
 * Telefonda yönetimin girişi bölüm listesidir (kenar çubuğu yok); tablet ve bilgisayarda kenar çubuğu
 * göründüğü için ilk bölüme geçilir.
 */
function AdminIndex() {
  const can = useCan();
  const wide = useMediaQuery('(min-width: 768px)');
  const sections = visibleSections(can);
  if (!sections.length) return <Navigate to="/" replace />;
  if (wide) return <Navigate to={sections[0].to} replace />;
  return (
    <>
      <PageHeader title="Yönetim" description="Menü, masa planı, personel, cihazlar ve bağlantılar" />
      <div className="space-y-6">
        {ADMIN_GROUPS.map((g) => {
          const list = sections.filter((s) => s.group === g.key);
          if (!list.length) return null;
          return (
            // Grup başlığı bilgisayardaki alt menü kartı gibi küçük, soluk ve büyük harfsiz (Genel, Menü, Salon ve kasa);
            // kartın iç kenarıyla (16 px) hizalı
            <section key={g.key}>
              <h2 className="px-4 pb-2 text-[13px] font-medium text-[var(--admin-text-mute)]">{g.label}</h2>
              <ul className={`${CARD} divide-y divide-[var(--admin-divider)] overflow-hidden`}>
                {list.map((s) => (
                  <li key={s.key}>
                    <Link to={s.to} className="flex min-h-[68px] items-center gap-3 px-4 py-3.5 transition-colors hover:bg-hover active:bg-press focus-visible:-outline-offset-2">
                      {/* Tek ve renksiz ton, bilgisayardaki kenar çubuğu gibi: renk durumun, bölümleri süslemez */}
                      <IconBox size="lg">
                        <s.icon />
                      </IconBox>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-[var(--admin-text)]">{s.label}</span>
                        <span className="mt-0.5 line-clamp-2 text-xs text-[var(--admin-text-mute)]">{s.desc}</span>
                      </span>
                      <ChevronRight className="size-5 shrink-0 text-[var(--admin-border-field)]" aria-hidden="true" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}

export default function AdminPage() {
  return (
    <AdminShell title="Yönetim">
      <Suspense fallback={<PageLoading />}>
        <Routes>
          <Route index element={<AdminIndex />} />
          {Object.keys(PAGES).map((key) => (
            <Route key={key} path={key} element={<SectionRoute sectionKey={key} />} />
          ))}
          <Route path="*" element={<Navigate to="/yonetim" replace />} />
        </Routes>
      </Suspense>
    </AdminShell>
  );
}
