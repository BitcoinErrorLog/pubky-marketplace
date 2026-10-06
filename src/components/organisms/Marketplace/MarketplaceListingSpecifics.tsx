'use client';

import { useRouter } from 'next/navigation';
import { Info } from 'lucide-react';
import { APP_ROUTES } from '@/app/routes';
import { Heading } from '@/atoms/Heading/Heading';
import {
  commerceAttributeLabel,
  commerceAttributeValueLabel,
  commerceCategoryLabel,
  resolveCommerceCategory,
} from '@/config/taxonomy/taxonomy';
import type { CommerceListingRecord } from '@/libs/commerce/marketplace-records';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

export interface MarketplaceListingSpecificsProps {
  record: Pick<CommerceListingRecord, 'categoryId' | 'attributes' | 'description'>;
}

/**
 * The item-specifics table on the listing detail page: the category
 * breadcrumb plus every attribute the record carries. Keys this build's
 * taxonomy knows get their configured labels and vocabulary display values;
 * anything else (records from other clients or newer taxonomies) renders as
 * a prettified label with the raw value — attributes are never dropped.
 */
export function MarketplaceListingSpecifics({ record }: MarketplaceListingSpecificsProps) {
  const router = useRouter();
  const categoryPath = resolveCommerceCategory(record.categoryId)?.path ?? [
    { id: record.categoryId, label: commerceCategoryLabel(record.categoryId) },
  ];
  const browseCategory = (categoryId: string) => {
    const store = useCommerceStore.getState();
    store.resetFilters();
    store.setCategoryId(categoryId);
    router.push(APP_ROUTES.MARKETPLACE);
  };
  const attributeEntries = Object.entries(record.attributes ?? {});

  return (
    <div
      className="flex min-w-0 items-start gap-3 rounded-xl bg-card p-5 text-card-foreground shadow-sm sm:col-span-2"
      data-cy="marketplace-listing-specifics"
    >
      <Info className="size-5 shrink-0 text-brand" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Heading level={2} size="sm" className="text-sm leading-5 font-semibold">
          Item specifics
        </Heading>
        <dl className="grid grid-cols-[minmax(80px,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm [&_dd]:break-words [&_dt]:break-words">
          <dt className="text-muted-foreground">Category</dt>
          <dd className="flex flex-wrap items-center gap-x-1">
            {categoryPath.map(({ id, label }, index) => (
              <span key={id}>
                {index > 0 && (
                  <span aria-hidden="true" className="mr-1 text-muted-foreground">
                    ›
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => browseCategory(id)}
                  aria-label={`Browse ${label}`}
                  className="cursor-pointer rounded-sm text-left font-medium underline-offset-4 hover:text-brand hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {label}
                </button>
              </span>
            ))}
          </dd>
          {attributeEntries.map(([key, value]) => (
            <SpecificsRow key={key} attributeKey={key} value={value} />
          ))}
          {record.description && (
            <>
              <dt className="text-muted-foreground">Description</dt>
              <dd className="[overflow-wrap:anywhere] whitespace-pre-wrap">{record.description}</dd>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}

function SpecificsRow({ attributeKey, value }: { attributeKey: string; value: string | string[] }) {
  const values = Array.isArray(value) ? value : [value];
  return (
    <>
      <dt className="text-muted-foreground">{commerceAttributeLabel(attributeKey)}</dt>
      <dd>{values.map((entry) => commerceAttributeValueLabel(attributeKey, entry)).join(', ')}</dd>
    </>
  );
}
