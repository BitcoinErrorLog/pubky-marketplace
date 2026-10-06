'use client';

import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Bitcoin,
  CalendarClock,
  Check,
  ChevronDown,
  Clock,
  DollarSign,
  Gavel,
  Grip,
  Layers,
  LayoutGrid,
  MapPin,
  Package,
  RotateCcw,
  Rows4,
  Sparkles,
  Star,
  Timer,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, buttonVariants } from '@/atoms/Button/Button';
import { Card } from '@/atoms/Card/Card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/atoms/DropdownMenu/DropdownMenu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/atoms/Select/Select';
import { Typography } from '@/atoms/Typography/Typography';
import {
  commerceAttributeLabel,
  commerceAttributeSetKeys,
  commerceAttributeValueLabel,
  commerceCategoryChildren,
  resolveCommerceCategory,
} from '@/config/taxonomy/taxonomy';
import type { MarketplaceCatalogItem } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import { collectMarketplaceAttributeFacets } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import { cn } from '@/libs/utils/utils';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import type { CommerceSaleFormatFilter, CommerceSort } from '@/stores/commerce/commerce.types';
import { useMarketplaceDisplayStore } from '@/stores/marketplace-display/marketplace-display.store';
import { MARKETPLACE_CATEGORY_ICONS } from './MarketplaceCategoryIcons';

/** Facetable attribute keys, shown when the current category defines them. */
const FACET_KEYS = ['size', 'brand', 'color'] as const;
/** Most facet value chips rendered per attribute key. */
const MAX_FACET_VALUES = 10;

// Match Arena's SidebarButton filter pills using the shared button styles.
const FILTER_TRIGGER_CLASS = cn(
  buttonVariants({ variant: 'dark-outline', size: 'sm' }),
  'max-w-64 gap-1.5 border-border bg-white/5 text-xs font-bold text-foreground focus-visible:border-border focus-visible:ring-0 data-[size=default]:h-8 data-[state=open]:text-white [&>svg:last-child]:size-3.5',
);
const CATEGORY_MENU_CLASS =
  'w-64 max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto border-border bg-background p-3';
const CATEGORY_ITEM_CLASS =
  'gap-2 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-white/8 hover:text-white focus:bg-white/8 focus:text-white data-[highlighted]:bg-white/8 data-[highlighted]:text-white data-[state=open]:bg-white/8 data-[state=open]:text-white data-[state=checked]:bg-white/8 data-[state=checked]:text-white data-[selected=true]:bg-white/8 data-[selected=true]:text-white';

const FILTER_MENU_CLASS = cn(
  CATEGORY_MENU_CLASS,
  'max-h-[min(70vh,var(--radix-select-content-available-height))] border shadow-xl ring-0 [&_[data-state=checked]_svg]:text-white',
);
const FILTER_ITEM_CLASS = cn(CATEGORY_ITEM_CLASS, 'cursor-pointer rounded-sm pr-8 pl-2');

export interface MarketplaceFiltersProps {
  resultCount: number;
  searchControl?: ReactNode;
  sellControl?: ReactNode;
  /**
   * Items matching every filter except the attribute facets — the pool the
   * facet chips are computed from (see `useMarketplaceCatalog`).
   */
  facetPool?: MarketplaceCatalogItem[];
  countryFacetPool?: MarketplaceCatalogItem[];
}

/** `US` → `United States`; falls back to the raw code for unknown values. */
function countryLabel(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function collectMarketplaceCountryFacets(items: MarketplaceCatalogItem[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const code = item.location.countryCode;
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
}

export function MarketplaceFilters({
  resultCount,
  searchControl,
  sellControl,
  facetPool = [],
  countryFacetPool = facetPool,
}: MarketplaceFiltersProps) {
  const hasActiveFilters = useCommerceStore((state) =>
    Boolean(
      state.query ||
      state.categoryId ||
      state.saleFormat !== 'all' ||
      state.countryCode ||
      state.conditions.length ||
      state.minimumPriceMinor !== null ||
      state.maximumPriceMinor !== null ||
      state.sort !== 'recommended' ||
      Object.keys(state.attributeFilters).length > 0,
    ),
  );
  const resetFilters = useCommerceStore((state) => state.resetFilters);
  const categoryId = useCommerceStore((state) => state.categoryId);
  const attributeFilters = useCommerceStore((state) => state.attributeFilters);
  const saleFormat = useCommerceStore((state) => state.saleFormat);
  const countryCode = useCommerceStore((state) => state.countryCode);
  const sort = useCommerceStore((state) => state.sort);
  const displayCurrency = useMarketplaceDisplayStore((state) => state.displayCurrency);
  const setDisplayCurrency = useMarketplaceDisplayStore((state) => state.setDisplayCurrency);
  const layout = useCommerceStore((state) => state.layout);
  const setCategoryId = useCommerceStore((state) => state.setCategoryId);
  const setAttributeFilter = useCommerceStore((state) => state.setAttributeFilter);
  const setSaleFormat = useCommerceStore((state) => state.setSaleFormat);
  const setCountryCode = useCommerceStore((state) => state.setCountryCode);
  const setSort = useCommerceStore((state) => state.setSort);
  const setLayout = useCommerceStore((state) => state.setLayout);

  // The seller-declared item locations actually present in the visible
  // catalog, with counts. The active selection stays listed even when it
  // currently matches nothing (the pool is filtered by it), so it can
  // always be seen and cleared.
  const countryCounts = new Map(collectMarketplaceCountryFacets(countryFacetPool));
  if (countryCode && !countryCounts.has(countryCode)) countryCounts.set(countryCode, 0);
  const countryOptions = [...countryCounts.entries()].sort(([left], [right]) => left.localeCompare(right));

  return (
    <section aria-label="Marketplace filters" className="flex flex-col gap-4">
      <Card className="flex-row flex-wrap items-center gap-2 p-4">
        {searchControl ?? (
          <Typography className="min-w-48 flex-1 text-sm text-muted-foreground">
            {resultCount.toLocaleString('en-US')} {resultCount === 1 ? 'item' : 'items'}
          </Typography>
        )}
        <div className="contents">
          <Select value={saleFormat} onValueChange={(value) => setSaleFormat(value as CommerceSaleFormatFilter)}>
            <SelectTrigger aria-label="Sale format" className={FILTER_TRIGGER_CLASS}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start" className={FILTER_MENU_CLASS}>
              <SelectItem className={FILTER_ITEM_CLASS} value="all">
                <LayoutGrid aria-hidden="true" className="size-4" />
                Type
              </SelectItem>
              <SelectItem className={FILTER_ITEM_CLASS} value="fixed_price">
                <Star aria-hidden="true" className="size-4" />
                Buy now
              </SelectItem>
              <SelectItem className={FILTER_ITEM_CLASS} value="auction">
                <Gavel aria-hidden="true" className="size-4" />
                Auctions
              </SelectItem>
              <SelectItem className={FILTER_ITEM_CLASS} value="drops">
                <CalendarClock aria-hidden="true" className="size-4" />
                Drops
              </SelectItem>
            </SelectContent>
          </Select>
          <MarketplaceCategoryNavigation categoryId={categoryId} onSelect={setCategoryId} />

          <Select
            value={countryCode ?? 'anywhere'}
            onValueChange={(value) => setCountryCode(value === 'anywhere' ? null : value)}
          >
            <SelectTrigger aria-label="Item location" className={FILTER_TRIGGER_CLASS}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start" className={FILTER_MENU_CLASS}>
              <SelectItem className={FILTER_ITEM_CLASS} value="anywhere">
                <MapPin aria-hidden="true" className="size-4" />
                Anywhere
              </SelectItem>
              {countryOptions.map(([code, count]) => (
                <SelectItem className={FILTER_ITEM_CLASS} key={code} value={code}>
                  <MapPin aria-hidden="true" className="size-4" />
                  {countryLabel(code)} · {count}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={sort} onValueChange={(value) => setSort(value as CommerceSort)}>
            <SelectTrigger aria-label="Sort marketplace" className={FILTER_TRIGGER_CLASS}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start" className={FILTER_MENU_CLASS}>
              <SelectItem className={FILTER_ITEM_CLASS} value="recommended">
                <Sparkles aria-hidden="true" className="size-4" />
                Recommended
              </SelectItem>
              <SelectItem className={FILTER_ITEM_CLASS} value="newest">
                <Clock aria-hidden="true" className="size-4" />
                Newest
              </SelectItem>
              <SelectItem className={FILTER_ITEM_CLASS} value="price_low">
                <ArrowUpNarrowWide aria-hidden="true" className="size-4" />
                Price: low
              </SelectItem>
              <SelectItem className={FILTER_ITEM_CLASS} value="price_high">
                <ArrowDownWideNarrow aria-hidden="true" className="size-4" />
                Price: high
              </SelectItem>
              <SelectItem className={FILTER_ITEM_CLASS} value="ending_soon">
                <Timer aria-hidden="true" className="size-4" />
                Ending soon
              </SelectItem>
            </SelectContent>
          </Select>
          <Select value={layout} onValueChange={(value) => setLayout(value === 'list' ? 'list' : 'grid')}>
            <SelectTrigger
              aria-label={`Listing layout: ${layout === 'list' ? 'List' : 'Grid'}`}
              className={cn(FILTER_TRIGGER_CLASS, 'hidden sm:flex')}
            >
              {layout === 'list' ? (
                <Rows4 aria-hidden="true" className="size-4" />
              ) : (
                <Grip aria-hidden="true" className="size-4" />
              )}
            </SelectTrigger>
            <SelectContent position="popper" align="start" className={FILTER_MENU_CLASS}>
              <SelectItem className={FILTER_ITEM_CLASS} value="grid">
                <Grip aria-hidden="true" className="size-4" />
                Grid
              </SelectItem>
              <SelectItem className={FILTER_ITEM_CLASS} value="list">
                <Rows4 aria-hidden="true" className="size-4" />
                List
              </SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={displayCurrency}
            onValueChange={(value) => setDisplayCurrency(value === 'BTC' ? 'BTC' : 'USD')}
          >
            <SelectTrigger
              aria-label={`Display currency: ${displayCurrency === 'BTC' ? 'Bitcoin' : 'US dollars'}`}
              className={FILTER_TRIGGER_CLASS}
            >
              {displayCurrency === 'BTC' ? (
                <Bitcoin aria-hidden="true" className="size-4" />
              ) : (
                <DollarSign aria-hidden="true" className="size-4" />
              )}
            </SelectTrigger>
            <SelectContent position="popper" align="end" className={FILTER_MENU_CLASS}>
              <SelectItem className={FILTER_ITEM_CLASS} value="USD">
                <DollarSign aria-hidden="true" className="size-4" />
                US dollars
              </SelectItem>
              <SelectItem className={FILTER_ITEM_CLASS} value="BTC">
                <Bitcoin aria-hidden="true" className="size-4" />
                Bitcoin
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {hasActiveFilters && (
          <Button
            variant="dark-outline"
            size="icon"
            className="size-8 shrink-0 rounded-full border-border bg-white/5 text-foreground"
            aria-label="Reset search and filters"
            title="Reset search and filters"
            onClick={resetFilters}
          >
            <RotateCcw className="size-4" />
          </Button>
        )}
        {sellControl}
      </Card>

      <MarketplaceAttributeFacets
        categoryId={categoryId}
        facetPool={facetPool}
        attributeFilters={attributeFilters}
        onToggle={setAttributeFilter}
      />
    </section>
  );
}

function MarketplaceCategoryNavigation({
  categoryId,
  onSelect,
}: {
  categoryId: string | null;
  onSelect: (categoryId: string | null) => void;
}) {
  const selected = categoryId ? resolveCommerceCategory(categoryId) : null;
  const Icon = selected ? (MARKETPLACE_CATEGORY_ICONS[selected.node.label] ?? Package) : Layers;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="dark-outline" size="sm" className={FILTER_TRIGGER_CLASS} aria-label="Category">
          <Icon aria-hidden="true" className="size-4" />
          <span className="max-w-40 truncate">{selected?.node.label ?? 'Category'}</span>
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={CATEGORY_MENU_CLASS}>
        <DropdownMenuItem
          data-selected={!categoryId ? 'true' : undefined}
          className={CATEGORY_ITEM_CLASS}
          onSelect={() => onSelect(null)}
        >
          <Layers className="size-4" aria-hidden="true" />
          All Categories
          {!categoryId && <Check className="ml-auto size-4 text-white" aria-hidden="true" />}
        </DropdownMenuItem>
        <CategoryMenuItems parentId={null} categoryId={categoryId} onSelect={onSelect} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CategoryMenuItems({
  parentId,
  categoryId,
  onSelect,
}: {
  parentId: string | null;
  categoryId: string | null;
  onSelect: (categoryId: string | null) => void;
}) {
  return commerceCategoryChildren(parentId).map((node) => {
    const Icon = MARKETPLACE_CATEGORY_ICONS[node.label] ?? Package;
    const selected = categoryId === node.id;
    const content = (
      <>
        <Icon className="size-4" aria-hidden="true" />
        <span className="flex-1">{node.label}</span>
        {selected && <Check className="size-4 text-white" aria-hidden="true" />}
      </>
    );
    if (!commerceCategoryChildren(node.id).length) {
      return (
        <DropdownMenuItem
          key={node.id}
          data-selected={selected ? 'true' : undefined}
          className={CATEGORY_ITEM_CLASS}
          onSelect={() => onSelect(node.id)}
        >
          {content}
        </DropdownMenuItem>
      );
    }
    return (
      <DropdownMenuSub key={node.id}>
        <DropdownMenuSubTrigger data-selected={selected ? 'true' : undefined} className={CATEGORY_ITEM_CLASS}>
          {content}
        </DropdownMenuSubTrigger>
        <DropdownMenuPortal>
          <DropdownMenuSubContent className={CATEGORY_MENU_CLASS} sideOffset={6} collisionPadding={8}>
            <DropdownMenuItem
              data-selected={selected ? 'true' : undefined}
              className={CATEGORY_ITEM_CLASS}
              onSelect={() => onSelect(node.id)}
            >
              <Icon className="size-4" aria-hidden="true" />
              All {node.label}
              {selected && <Check className="ml-auto size-4 text-white" aria-hidden="true" />}
            </DropdownMenuItem>
            <CategoryMenuItems parentId={node.id} categoryId={categoryId} onSelect={onSelect} />
          </DropdownMenuSubContent>
        </DropdownMenuPortal>
      </DropdownMenuSub>
    );
  });
}

/**
 * Attribute facet chips for the current category (size/brand/color where the
 * category defines them), computed client-side over the cached catalog. The
 * scope note is honest: index projections do not carry attributes, so facets
 * cover items whose full record this device has cached.
 */
function MarketplaceAttributeFacets({
  categoryId,
  facetPool,
  attributeFilters,
  onToggle,
}: {
  categoryId: string | null;
  facetPool: MarketplaceCatalogItem[];
  attributeFilters: Record<string, string>;
  onToggle: (key: string, value: string | null) => void;
}) {
  if (!categoryId) return null;
  const categoryFacetKeys = commerceAttributeSetKeys(categoryId).filter((key) =>
    (FACET_KEYS as readonly string[]).includes(key),
  );
  if (categoryFacetKeys.length === 0) return null;

  const facets = collectMarketplaceAttributeFacets(facetPool, categoryFacetKeys);
  const rows = categoryFacetKeys
    .map((key) => ({ key, values: (facets.get(key) ?? []).slice(0, MAX_FACET_VALUES) }))
    .filter(({ key, values }) => values.length > 0 || attributeFilters[key] !== undefined);
  if (rows.length === 0) return null;

  return (
    <div className="flex flex-col gap-2" data-cy="marketplace-attribute-facets">
      {rows.map(({ key, values }) => (
        <div key={key} className="flex items-center gap-2 overflow-x-auto pb-1">
          <Typography
            as="span"
            className="shrink-0 text-[11px] leading-4 font-medium tracking-[1.2px] text-muted-foreground uppercase"
          >
            {commerceAttributeLabel(key)}
          </Typography>
          {values.map(({ value, count }) => {
            const isActive = attributeFilters[key] === value;
            return (
              <Button
                key={value}
                size="sm"
                variant={isActive ? 'default' : 'secondary'}
                className="shrink-0 rounded-full"
                aria-pressed={isActive}
                onClick={() => onToggle(key, isActive ? null : value)}
              >
                {commerceAttributeValueLabel(key, value)} · {count}
              </Button>
            );
          })}
          {attributeFilters[key] !== undefined && !values.some(({ value }) => value === attributeFilters[key]) && (
            <Button
              size="sm"
              variant="default"
              className="shrink-0 rounded-full"
              aria-pressed
              onClick={() => onToggle(key, null)}
            >
              {commerceAttributeValueLabel(key, attributeFilters[key])}
            </Button>
          )}
        </div>
      ))}
      <Typography as="p" className="text-xs text-muted-foreground">
        Item-specific filters cover listings whose full details are cached on this device.
      </Typography>
    </div>
  );
}
