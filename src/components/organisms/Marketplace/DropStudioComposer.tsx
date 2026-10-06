'use client';

import { CheckCircle2, ExternalLink, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Controller, useWatch } from 'react-hook-form';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Checkbox } from '@/atoms/Checkbox/Checkbox';
import { Input } from '@/atoms/Input/Input';
import { Label } from '@/atoms/Label/Label';
import { Link } from '@/atoms/Link/Link';
import { RadioGroup, RadioGroupItem } from '@/atoms/RadioGroup/RadioGroup';
import { Typography } from '@/atoms/Typography/Typography';
import { FORM_LABEL_CLASSES } from '@/config/forms';
import { type UseDropStudioResult } from '@/hooks/useDropStudio/useDropStudio';
import {
  DROP_DESCRIPTION_MAX_CHARS,
  DROP_MAX_LISTINGS,
  DROP_MAX_PER_BUYER_LIMIT,
  DROP_MAX_TOTAL_QUANTITY,
  DROP_STUDIO_FIELDS,
  DROP_TITLE_MAX_CHARS,
  type DropStudioData,
  type DropStudioListingRegistration,
} from '@/hooks/useDropStudio/useDropStudio.types';
import { formatCommerceMoney } from '@/libs/commerce/format';
import { ControlledInputField } from '@/molecules/ControlledInputField/ControlledInputField';
import { ControlledTextareaField } from '@/molecules/ControlledTextareaField/ControlledTextareaField';
import { RequiredToPublishSummary } from '@/molecules/Marketplace/RequiredToPublishSummary';
import { DropStudioPreviewCard } from '@/organisms/Marketplace/DropStudioPreviewCard';

export interface DropStudioComposerProps {
  studio: UseDropStudioResult;
}

/**
 * The Drop Studio composer: bundle registered listings, set the schedule and
 * caps, pick a truthful stock display, and publish. Publishing reports two
 * separate truths — the record PUT to the seller's homeserver and the
 * `drop.sync` service registration — with a retry that re-runs only the sync.
 */
export function DropStudioComposer({ studio }: DropStudioComposerProps) {
  const { form, listings, registration, publishStatus } = studio;
  const selectedListingIds = useWatch({ control: form.control, name: DROP_STUDIO_FIELDS.LISTING_IDS });
  const title = useWatch({ control: form.control, name: DROP_STUDIO_FIELDS.TITLE });
  const description = useWatch({ control: form.control, name: DROP_STUDIO_FIELDS.DESCRIPTION });
  const startsAtLocal = useWatch({ control: form.control, name: DROP_STUDIO_FIELDS.STARTS_AT });
  const endsAtLocal = useWatch({ control: form.control, name: DROP_STUDIO_FIELDS.ENDS_AT });

  const isPublishing = publishStatus.record === 'publishing' || publishStatus.sync === 'syncing';
  const everySelectedRegistered =
    selectedListingIds.length > 0 && selectedListingIds.every((id) => registration[id] === 'registered');
  const previewMediaUri =
    selectedListingIds
      .map((listingId) => listings.find((row) => row.listing_id === listingId))
      .flatMap((listing) => listing?.record.media.filter((asset) => asset.type === 'image') ?? [])[0]?.url ?? null;
  const publishIssues = getDropPublishIssues(form.formState.errors, studio.publishErrors);

  const toggleListing = (listingId: string, checked: boolean) => {
    const current = form.getValues(DROP_STUDIO_FIELDS.LISTING_IDS);
    const next = checked
      ? [...current.filter((id) => id !== listingId), listingId]
      : current.filter((id) => id !== listingId);
    form.setValue(DROP_STUDIO_FIELDS.LISTING_IDS, next, { shouldValidate: true });
  };

  return (
    <form
      className="flex flex-col gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        void studio.publish().then(async () => {
          const formIsValid = await form.trigger();
          if (!formIsValid) {
            const firstInvalidField = Object.values(DROP_STUDIO_FIELDS).find(
              (field) => form.getFieldState(field as keyof DropStudioData).error,
            );
            if (firstInvalidField) scrollToDropStudioField(firstInvalidField);
          }
        });
      }}
    >
      <section className="flex flex-col gap-4">
        <Typography as="h2" className="text-xl font-semibold">
          Announce
        </Typography>
        <ControlledInputField
          name={DROP_STUDIO_FIELDS.TITLE}
          control={form.control}
          label="Drop title"
          placeholder="Winter capsule — 100 numbered pieces"
          maxLength={DROP_TITLE_MAX_CHARS}
          disabled={isPublishing}
        />
        <ControlledTextareaField
          name={DROP_STUDIO_FIELDS.DESCRIPTION}
          control={form.control}
          label="Description"
          placeholder="What is dropping, and why it matters."
          maxLength={DROP_DESCRIPTION_MAX_CHARS}
          disabled={isPublishing}
        />
      </section>

      <section id={DROP_STUDIO_FIELDS.LISTING_IDS} tabIndex={-1} className="flex flex-col gap-3">
        <Typography as="h2" className="text-xl font-semibold">
          Listings in this drop
        </Typography>
        <Typography as="p" className="text-sm text-muted-foreground">
          A drop bundles up to {DROP_MAX_LISTINGS} of your published listings. Each listing must be ready to sell before
          launch.
        </Typography>
        {studio.catalog === 'loading' ? (
          <Card className="border-dashed py-4">
            <CardContent className="flex items-center gap-2 px-5 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
              Loading your listings…
            </CardContent>
          </Card>
        ) : studio.catalog === 'unavailable' ? (
          <Card className="border-dashed py-4">
            <CardContent className="flex flex-col gap-3 px-5">
              <Typography as="p" className="text-sm text-muted-foreground">
                Your catalog could not be loaded — retry.
              </Typography>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="w-fit rounded-full"
                onClick={studio.retryCatalog}
              >
                <RefreshCw className="mr-1.5 size-3.5" />
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : listings.length === 0 ? (
          <Card className="border-dashed py-4">
            <CardContent className="flex flex-col gap-2 px-5">
              <Typography as="p" className="text-sm text-muted-foreground">
                You have no active listings to bundle yet.
              </Typography>
              <Link href={MARKETPLACE_ROUTES.SELL} className="inline-flex items-center gap-1 text-sm">
                Create a listing first
                <ExternalLink className="size-3.5" />
              </Link>
            </CardContent>
          </Card>
        ) : (
          <ul className="flex flex-col gap-2">
            {listings.map((listing) => {
              const isSelected = selectedListingIds.includes(listing.listing_id);
              return (
                <li
                  key={listing.listing_id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                >
                  <div className="flex items-center gap-3">
                    <Checkbox
                      id={`drop-listing-${listing.listing_id}`}
                      checked={isSelected}
                      disabled={isPublishing || (!isSelected && selectedListingIds.length >= DROP_MAX_LISTINGS)}
                      onCheckedChange={(checked) => toggleListing(listing.listing_id, checked === true)}
                      aria-label={`Include ${listing.record.title} in the drop`}
                    />
                    <Label htmlFor={`drop-listing-${listing.listing_id}`} className="cursor-pointer">
                      <span className="font-medium">{listing.record.title}</span>
                      <span className="ml-2 text-sm text-muted-foreground">
                        {listing.record.sale.format === 'fixed_price'
                          ? formatCommerceMoney(listing.record.sale.unitPrice)
                          : 'Auction'}
                      </span>
                    </Label>
                  </div>
                  {isSelected && (
                    <DropStudioListingRegistrationChip
                      state={registration[listing.listing_id] ?? 'checking'}
                      onRegister={() => void studio.registerListing(listing.listing_id)}
                      disabled={isPublishing}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {form.formState.errors.listingIds && (
          <Typography as="p" role="alert" className="text-sm text-destructive">
            {form.formState.errors.listingIds.message}
          </Typography>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <Typography as="h2" className="text-xl font-semibold">
          Schedule
        </Typography>
        <div className="grid gap-4 sm:grid-cols-2">
          <DropStudioScheduleField
            form={form}
            name={DROP_STUDIO_FIELDS.STARTS_AT}
            label="Launch (your local time)"
            value={startsAtLocal}
            disabled={isPublishing}
          />
          <DropStudioScheduleField
            form={form}
            name={DROP_STUDIO_FIELDS.ENDS_AT}
            label="End (optional — empty runs until sell-out or cancel)"
            value={endsAtLocal}
            disabled={isPublishing}
          />
        </div>
        <Typography as="p" className="text-sm text-muted-foreground">
          Server time governs. These times are your stated intent in the published record; the transaction
          service&apos;s clock decides when the drop is actually live and when it ends.
        </Typography>
      </section>

      <section className="flex flex-col gap-4">
        <Typography as="h2" className="text-xl font-semibold">
          Caps
        </Typography>
        <div className="grid gap-4 sm:grid-cols-2">
          <ControlledInputField
            name={DROP_STUDIO_FIELDS.TOTAL_QUANTITY}
            control={form.control}
            label="Total quantity"
            labelHint={`1 to ${DROP_MAX_TOTAL_QUANTITY.toLocaleString('en-US')} units across the whole drop`}
            placeholder="How many units in total"
            disabled={isPublishing}
          />
          <ControlledInputField
            name={DROP_STUDIO_FIELDS.PER_BUYER_LIMIT}
            control={form.control}
            label="Per-buyer limit"
            labelHint={`1 to ${DROP_MAX_PER_BUYER_LIMIT} units per buyer, never more than the total`}
            placeholder="1"
            disabled={isPublishing}
          />
        </div>
        <Typography as="p" className="text-sm text-muted-foreground">
          The service enforces both caps under concurrency. Per-buyer limits bound enthusiasm, not sybils — creating
          pubkys is free, and this UI will not claim otherwise.
        </Typography>
      </section>

      <section className="flex flex-col gap-3">
        <Typography as="h2" className="text-xl font-semibold">
          Stock display
        </Typography>
        <Controller
          name={DROP_STUDIO_FIELDS.STOCK_DISPLAY}
          control={form.control}
          render={({ field }) => (
            <RadioGroup value={field.value} onValueChange={field.onChange} disabled={isPublishing}>
              <RadioGroupItem
                value="exact"
                variant="box"
                label="Exact"
                description="Buyers see the exact remaining count, straight from the service."
              />
              <RadioGroupItem
                value="bands"
                variant="box"
                label="Bands"
                description="Buyers see coarse, truthful bands — plenty / low / last few."
              />
              <RadioGroupItem
                value="hidden"
                variant="box"
                label="Hidden"
                description="Buyers see no stock level at all."
              />
            </RadioGroup>
          )}
        />
        <Typography as="p" className="text-sm text-muted-foreground">
          Whichever you pick, stock is never invented: the redaction happens server-side, exact numbers stay
          seller-only, and &ldquo;sold out&rdquo; only ever comes from the service.
        </Typography>
      </section>

      <section className="flex flex-col gap-2">
        <Typography as="h2" className="text-xl font-semibold">
          Format
        </Typography>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">FCFS</Badge>
          <Typography as="p" className="text-sm text-muted-foreground">
            FCFS is a race — the service answers instantly, first come first served.
          </Typography>
        </div>
        <Typography as="p" className="text-sm text-muted-foreground">
          The drop&apos;s terms are locked at launch. Listings release only after the drop ends.
        </Typography>
      </section>

      <section className="flex flex-col gap-3">
        <Typography as="h2" className="text-xl font-semibold">
          Preview as shopper
        </Typography>
        <DropStudioPreviewCard
          title={title}
          description={description}
          mediaUri={previewMediaUri}
          startsAtIso={toPreviewIso(startsAtLocal)}
          endsAtIso={
            endsAtLocal !== '' && !Number.isNaN(Date.parse(endsAtLocal)) ? new Date(endsAtLocal).toISOString() : null
          }
          listingCount={selectedListingIds.length}
        />
      </section>

      <section className="flex flex-col gap-3">
        {studio.publishErrors.length > 0 && (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
            <Typography as="p" className="text-sm font-semibold text-destructive">
              The drop record is not valid yet:
            </Typography>
            <ul className="mt-1 list-disc pl-5">
              {studio.publishErrors.map((message) => (
                <li key={message} className="text-sm text-destructive">
                  {message}
                </li>
              ))}
            </ul>
          </div>
        )}
        {!everySelectedRegistered && selectedListingIds.length > 0 && (
          <Typography as="p" className="text-sm text-muted-foreground">
            Publishing unlocks once every bundled listing shows &ldquo;Registered&rdquo; with the service.
          </Typography>
        )}
        {publishIssues.length > 0 && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3" role="alert">
            <RequiredToPublishSummary
              items={publishIssues.map(({ field, label, message }) => ({
                id: field,
                label,
                description: message,
                onSelect: () => scrollToDropStudioField(field),
              }))}
              titleClassName="text-sm font-semibold text-destructive"
              listClassName="mt-1 list-disc pl-5 text-sm"
              itemClassName="text-destructive underline underline-offset-2"
            />
          </div>
        )}
        <Button
          type="submit"
          className="w-fit rounded-full"
          disabled={isPublishing || !everySelectedRegistered || publishStatus.record === 'ok'}
        >
          {publishStatus.record === 'publishing' ? 'Publishing…' : 'Publish drop'}
        </Button>
        <DropStudioPublishTruths studio={studio} />
      </section>
    </form>
  );
}

const DROP_STUDIO_FIELD_LABELS: Record<string, string> = {
  title: 'Drop title',
  description: 'Description',
  listingIds: 'Listings',
  startsAtLocal: 'Launch time',
  endsAtLocal: 'End time',
  totalQuantity: 'Total quantity',
  perBuyerLimit: 'Per-buyer limit',
  stockDisplay: 'Stock display',
};

function getDropPublishIssues(
  errors: Record<string, { message?: unknown } | undefined>,
  publishErrors: string[],
): { field: string; label: string; message: string }[] {
  const issues = Object.entries(errors)
    .filter(([, error]) => error)
    .map(([field, error]) => ({
      field,
      label: DROP_STUDIO_FIELD_LABELS[field] ?? field,
      message: typeof error?.message === 'string' ? error.message : '',
    }));
  for (const error of publishErrors) {
    const [field, ...messageParts] = error.split(':');
    if (DROP_STUDIO_FIELD_LABELS[field] && !issues.some((issue) => issue.field === field)) {
      issues.push({ field, label: DROP_STUDIO_FIELD_LABELS[field], message: messageParts.join(':').trim() });
    }
  }
  return issues;
}

function scrollToDropStudioField(field: string): void {
  const control = document.getElementById(field) ?? document.getElementById(`drop-${field}`);
  if (!control) return;
  control.scrollIntoView({ block: 'center' });
  if (control instanceof HTMLElement) control.focus();
}

/** Publish status summary with the homeserver/service detail available on demand. */
function DropStudioPublishTruths({ studio }: { studio: UseDropStudioResult }) {
  const { publishStatus, publishedDropId } = studio;
  if (publishStatus.record === 'idle' || publishStatus.record === 'publishing') return null;
  const statusLabel = publishStatus.record === 'ok' && publishStatus.sync === 'ok' ? 'Scheduled' : 'Draft';
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-4" role="status">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={statusLabel === 'Scheduled' ? 'secondary' : 'outline'}>{statusLabel}</Badge>
        <Typography as="p" className="text-sm text-muted-foreground">
          {statusLabel === 'Scheduled'
            ? 'The drop is registered and waiting for the service clock.'
            : 'The drop is not registered with the service yet.'}
        </Typography>
      </div>
      <details className="rounded-md border border-border/70 p-3">
        <summary className="cursor-pointer text-sm font-medium">Technical details</summary>
        <div className="mt-3 flex flex-col gap-2">
          <DropStudioTruthRow
            label="Record on your homeserver"
            state={publishStatus.record === 'ok' ? 'ok' : 'failed'}
          />
          <div className="flex flex-wrap items-center gap-2">
            <DropStudioTruthRow
              label="Registered with the service"
              state={publishStatus.sync === 'ok' ? 'ok' : publishStatus.sync === 'syncing' ? 'pending' : 'failed'}
            />
            {publishStatus.sync === 'failed' && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="rounded-full"
                onClick={() => void studio.retrySync()}
              >
                <RefreshCw className="mr-1.5 size-3.5" />
                Retry registration
              </Button>
            )}
          </div>
        </div>
      </details>
      {publishStatus.record === 'ok' && publishedDropId && (
        <Link href={`${MARKETPLACE_ROUTES.SELL_DROPS}/${publishedDropId}`} className="inline-flex w-fit text-sm">
          Open mission control
        </Link>
      )}
    </div>
  );
}

function DropStudioTruthRow({ label, state }: { label: string; state: 'ok' | 'pending' | 'failed' }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      {state === 'ok' && <CheckCircle2 className="size-4 text-brand" aria-hidden />}
      {state === 'pending' && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />}
      {state === 'failed' && <XCircle className="size-4 text-destructive" aria-hidden />}
      {label}
      <span className="sr-only">{state === 'ok' ? '— done' : state === 'pending' ? '— in progress' : '— failed'}</span>
    </span>
  );
}

function DropStudioListingRegistrationChip({
  state,
  onRegister,
  disabled,
}: {
  state: DropStudioListingRegistration;
  onRegister: () => void;
  disabled: boolean;
}) {
  if (state === 'registered') {
    return <Badge variant="secondary">Registered</Badge>;
  }
  if (state === 'checking') {
    return (
      <Badge variant="outline">
        <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
        Checking…
      </Badge>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Badge variant="outline">{state === 'unregistered' ? 'Not registered' : 'Registration unknown'}</Badge>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="rounded-full"
        disabled={disabled}
        onClick={onRegister}
      >
        Register
      </Button>
    </span>
  );
}

/**
 * datetime-local inputs speak the device time zone; the record speaks UTC.
 * Rendering both under the field is the explicit-timezone requirement — the
 * seller sees exactly what the public record will say.
 */
function DropStudioScheduleField({
  form,
  name,
  label,
  value,
  disabled,
}: {
  form: UseDropStudioResult['form'];
  name: typeof DROP_STUDIO_FIELDS.STARTS_AT | typeof DROP_STUDIO_FIELDS.ENDS_AT;
  label: string;
  value: string;
  disabled: boolean;
}) {
  const parsedMs = value.trim() === '' ? Number.NaN : Date.parse(value);
  const error = form.formState.errors[name];
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`drop-${name}`} className={FORM_LABEL_CLASSES}>
        {label}
      </Label>
      <Controller
        name={name}
        control={form.control}
        render={({ field }) => (
          <div className="flex items-center gap-2">
            <Input
              id={`drop-${name}`}
              type="datetime-local"
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              max="9999-12-31T23:59"
              disabled={disabled}
              aria-invalid={!!error}
            />
            {name === DROP_STUDIO_FIELDS.ENDS_AT && field.value !== '' && (
              <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => field.onChange('')}>
                Clear
              </Button>
            )}
          </div>
        )}
      />
      {!Number.isNaN(parsedMs) && (
        <Typography as="p" className="text-xs text-muted-foreground">
          Local: {new Date(parsedMs).toLocaleString()} · UTC:{' '}
          {new Date(parsedMs).toISOString().replace('T', ' ').slice(0, 16)}
        </Typography>
      )}
      {error && (
        <Typography as="p" role="alert" className="text-sm text-destructive">
          {error.message}
        </Typography>
      )}
    </div>
  );
}

function toPreviewIso(startsAtLocal: string): string {
  const parsed = Date.parse(startsAtLocal);
  // An unset/invalid launch previews as "one hour from now" so the card shows
  // the announced shape — labeled an estimate either way.
  return Number.isNaN(parsed) ? new Date(Date.now() + 60 * 60_000).toISOString() : new Date(parsed).toISOString();
}
