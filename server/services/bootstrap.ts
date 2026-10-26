import { asc, eq } from 'drizzle-orm';
import type { BootstrapDTO, MeDTO, OptionGroupDTO, ProductDTO } from '@shared/types';
import { type DB, schema, type Tx } from '../db/client';
import { type AuthUser, can } from '../lib/auth';
import { env } from '../env';
import { getPublicSettings, getSettings } from '../lib/settings';
import { dayToDTO } from './days';
import { getOpenDay } from './orders';

export function meDTO(u: AuthUser): MeDTO {
  return { id: u.id, name: u.name, role: u.role, color: u.color, permissions: [...u.permissions], maxDiscountPct: u.maxDiscountPct };
}

export function menuProducts(t: Tx | DB, withCost: boolean): ProductDTO[] {
  const links = t.select().from(schema.productOptionGroups).orderBy(asc(schema.productOptionGroups.sort)).all();
  const byProduct = new Map<string, string[]>();
  for (const l of links) (byProduct.get(l.productId) ?? byProduct.set(l.productId, []).get(l.productId)!).push(l.groupId);
  return t
    .select()
    .from(schema.products)
    .orderBy(asc(schema.products.sort), asc(schema.products.name))
    .all()
    .map((p) => ({
      id: p.id,
      categoryId: p.categoryId,
      name: p.name,
      shortName: p.shortName,
      description: p.description,
      price: p.price,
      priceL: p.priceL,
      kdvRate: p.kdvRate,
      stationId: p.stationId,
      color: p.color,
      image: p.image,
      active: p.active,
      hidden: p.hidden,
      favorite: p.favorite,
      sort: p.sort,
      tags: p.tags,
      allergens: p.allergens,
      barcode: p.barcode,
      isService: p.isService,
      portionsLeft: p.portionsLeft,
      extSource: p.extSource ?? null,
      extId: p.extId,
      posName: p.posName,
      ...(withCost ? { cost: p.cost } : {}),
      optionGroupIds: byProduct.get(p.id) ?? [],
    }));
}

export function menuOptionGroups(t: Tx | DB): OptionGroupDTO[] {
  const items = t.select().from(schema.optionItems).where(eq(schema.optionItems.active, true)).orderBy(asc(schema.optionItems.sort)).all();
  return t
    .select()
    .from(schema.optionGroups)
    .where(eq(schema.optionGroups.active, true))
    .orderBy(asc(schema.optionGroups.sort))
    .all()
    .map((g) => ({
      id: g.id,
      name: g.name,
      kind: g.kind,
      required: g.required,
      maxSelect: g.maxSelect,
      extKey: g.extKey,
      items: items
        .filter((i) => i.groupId === g.id)
        .map((i) => ({ id: i.id, name: i.name, code: i.code, price: i.price, isDefault: i.isDefault, maxQty: i.maxQty, allergens: i.allergens })),
    }));
}

export function bootstrap(t: Tx | DB, user: AuthUser): BootstrapDTO {
  return {
    me: meDTO(user),
    settings: getPublicSettings(),
    sections: t.select().from(schema.sections).where(eq(schema.sections.active, true)).orderBy(asc(schema.sections.sort)).all(),
    tables: t
      .select()
      .from(schema.tables)
      .where(eq(schema.tables.active, true))
      .orderBy(asc(schema.tables.sort))
      .all()
      .map((x) => ({
        id: x.id,
        sectionId: x.sectionId,
        name: x.name,
        seats: x.seats,
        shape: x.shape,
        x: x.x,
        y: x.y,
        w: x.w,
        h: x.h,
        kind: x.kind,
        hourlyRate: x.hourlyRate,
        siteTableCode: x.siteTableCode,
        sort: x.sort,
      })),
    stations: t
      .select()
      .from(schema.stations)
      .where(eq(schema.stations.active, true))
      .orderBy(asc(schema.stations.sort))
      .all()
      .map((s) => ({ id: s.id, name: s.name, kind: s.kind, color: s.color })),
    categories: t
      .select()
      .from(schema.categories)
      .orderBy(asc(schema.categories.sort))
      .all()
      .map((c) => ({
        id: c.id,
        name: c.name,
        subtitle: c.subtitle,
        color: c.color,
        sort: c.sort,
        stationId: c.stationId,
        customizable: c.customizable,
        extKey: c.extKey,
        active: c.active,
      })),
    products: menuProducts(t, can(user, 'rapor.maliyet')),
    optionGroups: menuOptionGroups(t),
    paymentMethods: t
      .select()
      .from(schema.paymentMethods)
      .where(eq(schema.paymentMethods.active, true))
      .orderBy(asc(schema.paymentMethods.sort))
      .all()
      .map((m) => ({ id: m.id, name: m.name, kind: m.kind, zField: m.zField, channel: m.channel, color: m.color })),
    happyHours: t.select().from(schema.happyHours).all(),
    users: t
      .select()
      .from(schema.users)
      .orderBy(asc(schema.users.name))
      .all()
      .map((u) => ({ id: u.id, name: u.name, role: u.role, color: u.color, active: u.active })),
    day: dayToDTO(t, getOpenDay(t)),
    integrations: {
      okc: { provider: getSettings().okcProvider, mode: getSettings().okcMode },
      laffogatoPanel: env.laffogatoPanelSecret.length >= 32,
      lafmaliyetPush: !!env.lafmaliyetUrl && env.lafmaliyetToken.length >= 32,
      laffogatoUrl: env.laffogatoUrl,
    },
    serverTime: Date.now(),
  };
}
