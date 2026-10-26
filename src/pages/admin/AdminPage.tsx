import { BadgePercent, ClipboardList, Coffee, CreditCard, Layers, LayoutGrid, MonitorSmartphone, PlugZap, Settings2, Users } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router';
import type { Permission } from '@shared/permissions';
import { PageLoading } from '@/components/ui/misc';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';

const MenuAdmin = lazy(() => import('./MenuAdmin'));
const OptionsAdmin = lazy(() => import('./OptionsAdmin'));
const FloorAdmin = lazy(() => import('./FloorAdmin'));
const UsersAdmin = lazy(() => import('./UsersAdmin'));
const SettingsAdmin = lazy(() => import('./SettingsAdmin'));
const PaymentsAdmin = lazy(() => import('./PaymentsAdmin'));
const OkcAdmin = lazy(() => import('./OkcAdmin'));
const IntegrationAdmin = lazy(() => import('./IntegrationAdmin'));
const AuditAdmin = lazy(() => import('./AuditAdmin'));

const SECTIONS: { to: string; label: string; icon: typeof Coffee; perm: Permission[] }[] = [
  { to: 'menu', label: 'Menü', icon: Coffee, perm: ['menu.yonet'] },
  { to: 'secenekler', label: 'Seçenek ve happy hour', icon: BadgePercent, perm: ['menu.yonet'] },
  { to: 'masa-plani', label: 'Masa planı', icon: LayoutGrid, perm: ['ayar.yonet'] },
  { to: 'personel', label: 'Personel ve yetki', icon: Users, perm: ['personel.yonet'] },
  { to: 'odeme', label: 'Ödeme türleri', icon: CreditCard, perm: ['ayar.yonet'] },
  { to: 'yazarkasa', label: 'Yazarkasa POS', icon: MonitorSmartphone, perm: ['ayar.yonet'] },
  { to: 'entegrasyon', label: 'Site ve lafmaliyet', icon: PlugZap, perm: ['senkron.yonet', 'ayar.yonet'] },
  { to: 'ayarlar', label: 'Ayarlar ve yedek', icon: Settings2, perm: ['ayar.yonet'] },
  { to: 'denetim', label: 'Denetim kaydı', icon: ClipboardList, perm: ['ayar.yonet', 'patron.panel'] },
];

export default function AdminPage() {
  const can = useCan();
  const visible = SECTIONS.filter((s) => s.perm.some((p) => can(p)));
  return (
    <div className="flex h-full flex-col lg:flex-row">
      <nav className="no-scrollbar flex gap-1 overflow-x-auto border-b border-line bg-surface p-2 lg:w-60 lg:flex-col lg:border-b-0 lg:border-r lg:p-3">
        <h1 className="hidden px-2 pb-2 text-xl font-semibold lg:flex lg:items-center lg:gap-2">
          <Layers className="size-5 text-forest-600" /> Yönetim
        </h1>
        {visible.map((s) => (
          <NavLink key={s.to} to={s.to} className={({ isActive }) => cn('flex shrink-0 items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium', isActive ? 'bg-forest-700 text-cream' : 'text-ink-2 hover:bg-surface-2')}>
            <s.icon className="size-4" />
            {s.label}
          </NavLink>
        ))}
      </nav>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <Suspense fallback={<PageLoading />}>
          <Routes>
            <Route index element={<Navigate to={visible[0]?.to ?? 'menu'} replace />} />
            <Route path="menu" element={<MenuAdmin />} />
            <Route path="secenekler" element={<OptionsAdmin />} />
            <Route path="masa-plani" element={<FloorAdmin />} />
            <Route path="personel" element={<UsersAdmin />} />
            <Route path="odeme" element={<PaymentsAdmin />} />
            <Route path="yazarkasa" element={<OkcAdmin />} />
            <Route path="entegrasyon" element={<IntegrationAdmin />} />
            <Route path="ayarlar" element={<SettingsAdmin />} />
            <Route path="denetim" element={<AuditAdmin />} />
            <Route path="*" element={<Navigate to="." replace />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}
