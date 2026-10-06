'use client';

import { useRef } from 'react';
import { FileUp, Trash2 } from 'lucide-react';
import { Controller, useWatch } from 'react-hook-form';
import { Button } from '@/atoms/Button/Button';
import { RadioGroup, RadioGroupItem } from '@/atoms/RadioGroup/RadioGroup';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { FORM_LABEL_CLASSES } from '@/config/forms';
import { useDigitalDeliveryEditor } from '@/hooks/useDigitalDeliveryEditor/useDigitalDeliveryEditor';
import {
  DIGITAL_DELIVERY_FORM_FIELDS,
  DIGITAL_DELIVERY_KIND_OPTIONS,
} from '@/hooks/useDigitalDeliveryEditor/useDigitalDeliveryEditor.types';
import {
  DIGITAL_DELIVERY_COPY,
  DIGITAL_DELIVERY_SETUP_COPY,
  DIGITAL_DELIVERY_TRUST_COPY,
  DIGITAL_TEXT_MAX_CHARS,
  digitalDeliveryCurrentSummary,
  formatDigitalFileSize,
} from '@/libs/commerce/digital';
import { ControlledInputField } from '@/molecules/ControlledInputField/ControlledInputField';
import { ControlledTextareaField } from '@/molecules/ControlledTextareaField/ControlledTextareaField';

/**
 * The Digital delivery panel on a listing's edit page (digital delivery
 * design §2): how buyers receive the listing after payment. It lives
 * post-publish because the service accepts `digital_delivery.set` only for a
 * registered listing that already sells by digital delivery.
 */
export function MarketplaceDigitalDeliveryEditor({
  listingId,
  available,
  maxBytes,
  published,
  disabled = false,
}: {
  listingId: string;
  /** The deployment's `/health` digital delivery capability; null while loading. */
  available: boolean | null;
  maxBytes: number | null;
  /** True when the saved listing already publishes Digital delivery. */
  published: boolean;
  disabled?: boolean;
}) {
  const editor = useDigitalDeliveryEditor({ listingId, enabled: available === true && published, maxBytes });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const kind = useWatch({ control: editor.form.control, name: DIGITAL_DELIVERY_FORM_FIELDS.KIND });
  const text = useWatch({ control: editor.form.control, name: DIGITAL_DELIVERY_FORM_FIELDS.TEXT });
  const busy = disabled || editor.isSaving;

  return (
    <section
      data-surface="digital-delivery-editor"
      aria-labelledby="digital-delivery-editor-heading"
      className="grid gap-4 rounded-xl border border-border/60 p-4"
    >
      <div className="grid gap-1">
        <Typography as="h3" id="digital-delivery-editor-heading" className="text-base font-semibold">
          How buyers receive it
        </Typography>
        <Typography as="p" className="text-sm text-muted-foreground">
          {DIGITAL_DELIVERY_TRUST_COPY}
        </Typography>
      </div>

      {available === null ? (
        <Skeleton className="h-24 w-full" aria-label="Checking digital delivery availability" />
      ) : !available ? (
        <Typography as="p" className="text-sm text-muted-foreground">
          {DIGITAL_DELIVERY_COPY.unavailable}
        </Typography>
      ) : !published ? (
        <Typography as="p" className="text-sm text-muted-foreground">
          {DIGITAL_DELIVERY_SETUP_COPY.not_published}
        </Typography>
      ) : editor.readState === 'loading' || editor.readState === 'idle' ? (
        <Skeleton className="h-24 w-full" aria-label="Loading digital delivery" />
      ) : editor.readState === 'failed' ? (
        <div className="flex flex-wrap items-center gap-3">
          <Typography as="p" role="alert" className="text-sm text-amber-300">
            {editor.error}
          </Typography>
          <Button type="button" variant="secondary" size="sm" onClick={() => void editor.reload()}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          <div className="grid gap-1" data-testid="digital-delivery-current">
            <Typography as="p" className="text-sm font-medium">
              {digitalDeliveryCurrentSummary(editor.delivery?.current ?? null)}
            </Typography>
            {editor.versionLine && (
              <Typography as="p" className="text-sm text-muted-foreground">
                {editor.versionLine}
              </Typography>
            )}
          </div>

          <Controller
            name={DIGITAL_DELIVERY_FORM_FIELDS.KIND}
            control={editor.form.control}
            render={({ field }) => (
              <RadioGroup
                value={field.value}
                onValueChange={field.onChange}
                aria-label="How buyers receive it"
                className="gap-2"
              >
                {DIGITAL_DELIVERY_KIND_OPTIONS.map((option) => (
                  <RadioGroupItem
                    key={option.kind}
                    value={option.kind}
                    variant="box"
                    label={option.label}
                    description={option.description}
                    disabled={busy}
                  />
                ))}
              </RadioGroup>
            )}
          />

          {kind === 'file' && (
            <div className="grid gap-2">
              <span className={FORM_LABEL_CLASSES}>File</span>
              <input
                ref={fileInputRef}
                type="file"
                className="sr-only"
                aria-label="Choose the file buyers receive"
                data-testid="digital-delivery-file-input"
                disabled={busy}
                onChange={(event) => {
                  editor.picker.choose(event.target.files?.[0] ?? null);
                  event.target.value = '';
                }}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FileUp className="mr-2 size-4" aria-hidden="true" />
                  {editor.picker.file ? 'Choose another file' : 'Choose file'}
                </Button>
                {editor.picker.file && (
                  <Typography as="p" className="text-sm" data-testid="digital-delivery-chosen-file">
                    {editor.picker.file.name} · {formatDigitalFileSize(editor.picker.file.size)}
                  </Typography>
                )}
              </div>
              {editor.picker.error && (
                <Typography as="p" role="alert" className="text-sm text-amber-300">
                  {editor.picker.error}
                </Typography>
              )}
            </div>
          )}

          {kind === 'link' && (
            <ControlledInputField
              name={DIGITAL_DELIVERY_FORM_FIELDS.URL}
              control={editor.form.control}
              label="Link"
              placeholder="https://"
              disabled={busy}
            />
          )}

          {kind === 'text' && (
            <div className="grid gap-1">
              <ControlledTextareaField
                name={DIGITAL_DELIVERY_FORM_FIELDS.TEXT}
                control={editor.form.control}
                label="Text every buyer receives"
                placeholder="A licence key, a code or instructions"
                maxLength={DIGITAL_TEXT_MAX_CHARS}
                disabled={busy}
              />
              <Typography as="p" className="text-xs text-muted-foreground">
                {Array.from(text ?? '').length.toLocaleString('en-US')} /{' '}
                {DIGITAL_TEXT_MAX_CHARS.toLocaleString('en-US')}
              </Typography>
            </div>
          )}

          {editor.error && (
            <Typography as="p" role="alert" className="text-sm text-amber-300" data-testid="digital-delivery-error">
              {editor.error}
            </Typography>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => void editor.submit()}>
              {editor.isSaving ? 'Saving…' : 'Save delivery'}
            </Button>
            {editor.delivery?.current && (
              <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void editor.clear()}>
                <Trash2 className="mr-2 size-4" aria-hidden="true" />
                Remove delivery
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
