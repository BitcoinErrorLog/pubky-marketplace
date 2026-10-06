'use client';

import { forwardRef, useImperativeHandle, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Controller, useFieldArray } from 'react-hook-form';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/atoms/Dialog/Dialog';
import { Input } from '@/atoms/Input/Input';
import { Label } from '@/atoms/Label/Label';
import { RadioGroup, RadioGroupItem } from '@/atoms/RadioGroup/RadioGroup';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/atoms/Select/Select';
import { Typography } from '@/atoms/Typography/Typography';
import { FORM_LABEL_CLASSES } from '@/config/forms';
import {
  type PickupDetailsCapability,
  type PickupDetailsReadState,
  usePickupDetailsForm,
} from '@/hooks/usePickupDetailsForm/usePickupDetailsForm';
import { PICKUP_DETAILS_FORM_FIELDS } from '@/hooks/usePickupDetailsForm/usePickupDetailsForm.types';
import { ControlledInputField } from '@/molecules/ControlledInputField/ControlledInputField';
import { ControlledTextareaField } from '@/molecules/ControlledTextareaField/ControlledTextareaField';
import { MarketplaceAddressFields } from '@/molecules/MarketplaceAddressFields/MarketplaceAddressFields';

const WEEKDAY_OPTIONS = [
  { value: 'mon', label: 'Mondays' },
  { value: 'tue', label: 'Tuesdays' },
  { value: 'wed', label: 'Wednesdays' },
  { value: 'thu', label: 'Thursdays' },
  { value: 'fri', label: 'Fridays' },
  { value: 'sat', label: 'Saturdays' },
  { value: 'sun', label: 'Sundays' },
] as const;

/**
 * The sell studio's pickup-details editor (local pickup design PART A,
 * §A1/§A4). The public listing record only signals THAT pickup is offered;
 * the meeting point is authored here and goes straight to the transaction
 * service (`pickup_details.set` with the payload-level CAS), sealed, and
 * revealed only to a buyer whose payment confirmed. Rendered inside the
 * listing form's <form>, so it deliberately renders no nested form element
 * and every button is type="button".
 *
 * The editor is honest about the deployment: when the service reports
 * `pickup_available` off (no sealing key configured, or sandbox payments —
 * sandbox deployments included), it says so and offers no fields (§A7).
 * Telemetry masking is binding (§7.2): the whole surface carries
 * `data-sentry-mask`, complementing Sentry Replay's global maskAllText /
 * maskAllInputs.
 */
export type MarketplacePickupDetailsEditorHandle = {
  save: () => Promise<boolean>;
  validate: () => Promise<boolean>;
  readonly isDirty: boolean;
  readonly hasSavedDetails: boolean;
  readonly capability: PickupDetailsCapability;
  readonly readState: PickupDetailsReadState;
};

export const MarketplacePickupDetailsEditor = forwardRef<
  MarketplacePickupDetailsEditorHandle,
  {
    listingId: string;
    disabled?: boolean;
    persistListing?: () => Promise<boolean>;
    revertListing?: () => Promise<boolean>;
  }
>(function MarketplacePickupDetailsEditor({ listingId, disabled = false, persistListing, revertListing }, ref) {
  const editor = usePickupDetailsForm(listingId, { persistListing, revertListing });
  useImperativeHandle(
    ref,
    () => ({
      save: () => editor.save(),
      validate: () => editor.form.trigger(),
      get isDirty() {
        return editor.form.formState.isDirty;
      },
      get hasSavedDetails() {
        return editor.currentVersion !== null;
      },
      get capability() {
        return editor.capability;
      },
      get readState() {
        return editor.readState;
      },
    }),
    [editor],
  );
  const [clearOpen, setClearOpen] = useState(false);

  if (editor.capability === 'loading') {
    return (
      <Typography as="p" className="text-sm text-muted-foreground">
        Checking whether this deployment supports local pickup…
      </Typography>
    );
  }

  if (editor.capability === 'unavailable') {
    return (
      <div className="grid gap-2 rounded-xl border border-dashed p-4" data-testid="pickup-unavailable-note">
        <Typography as="p" className="text-sm font-medium">
          Local pickup is not available on this deployment.
        </Typography>
        <Typography as="p" className="text-xs text-muted-foreground">
          Pickup details cannot be saved while the service runs without pickup encryption configured, or on a
          sandbox-payments deployment. You can still publish the listing, but buyers will not get a meeting point —
          choose Ship item instead, or publish pickup later from a deployment that supports it.
        </Typography>
      </div>
    );
  }

  if (editor.readState === 'loading') {
    return (
      <Typography as="p" className="text-sm text-muted-foreground">
        Loading your saved pickup details…
      </Typography>
    );
  }

  if (editor.readState === 'failed') {
    return (
      <div className="grid gap-3 rounded-xl border border-dashed p-4" data-testid="pickup-read-failed">
        <Typography as="p" className="text-sm text-muted-foreground">
          The saved pickup details could not be read, so editing is blocked — saving blind could overwrite what another
          device stored.
        </Typography>
        <Button type="button" size="sm" variant="secondary" className="w-fit rounded-full" onClick={editor.reload}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div
      className="grid gap-5 rounded-xl border border-dashed p-4"
      data-surface="pickup-details-editor"
      data-sentry-mask
      data-testid="pickup-details-editor"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Copy adapted from Igor's PR 22 listing-form note (credited prior
            art), reworded for the sealed meeting-point model. */}
        <Typography as="p" className="text-xs text-muted-foreground">
          Buyers see only that this listing offers pickup. The meeting point below is revealed to a buyer on the order
          page as soon as their payment confirms — it is never shown on the public listing.
        </Typography>
        {/* The seller-visible version counter (§A3): monotonic per listing,
            surviving clears, so a terms change after payment is always
            detectable and a delete-and-recreate cannot reset it. */}
        <Badge variant="outline" className="shrink-0" aria-label={`Pickup details version ${editor.lastVersion}`}>
          {editor.currentVersion !== null ? `Saved as version ${editor.currentVersion}` : 'No details saved'} · counter
          v{editor.lastVersion}
        </Badge>
      </div>

      <Controller
        name={PICKUP_DETAILS_FORM_FIELDS.KIND}
        control={editor.form.control}
        render={({ field }) => (
          <RadioGroup
            value={field.value}
            onValueChange={field.onChange}
            aria-label="Meeting point kind"
            className="gap-2"
          >
            <RadioGroupItem
              value="spot"
              variant="box"
              label="Pickup spot (recommended)"
              description="A public place — “Central Station, north entrance”. You never have to share your home."
              disabled={disabled || editor.isSaving}
            />
            <RadioGroupItem
              value="address"
              variant="box"
              label="An address"
              description="A full address, revealed only to the paying buyer."
              disabled={disabled || editor.isSaving}
            />
          </RadioGroup>
        )}
      />

      {editor.form.watch(PICKUP_DETAILS_FORM_FIELDS.KIND) === 'spot' ? (
        <ControlledInputField
          name={PICKUP_DETAILS_FORM_FIELDS.SPOT}
          control={editor.form.control}
          label="Meeting point"
          placeholder="Central Station, north entrance"
          disabled={disabled || editor.isSaving}
        />
      ) : (
        <div className="grid gap-4">
          <ControlledInputField
            name={PICKUP_DETAILS_FORM_FIELDS.NAME}
            control={editor.form.control}
            label="Name"
            placeholder="Front desk, Studio 4"
            disabled={disabled || editor.isSaving}
          />
          <MarketplaceAddressFields
            control={editor.form.control}
            setValue={editor.form.setValue}
            disabled={disabled || editor.isSaving}
          />
        </div>
      )}

      <ControlledTextareaField
        name={PICKUP_DETAILS_FORM_FIELDS.INSTRUCTIONS}
        control={editor.form.control}
        label="Handoff instructions (optional)"
        placeholder="Ring the bell twice; ask for Sam."
        rows={3}
        disabled={disabled || editor.isSaving}
      />

      <PickupAvailabilityFields editor={editor} disabled={disabled || editor.isSaving} />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          className="rounded-full"
          disabled={!editor.canSave || disabled}
          onClick={() => void editor.save()}
        >
          {editor.isSaving ? 'Saving…' : 'Save pickup details'}
        </Button>
        {editor.currentVersion !== null && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="rounded-full"
            disabled={!editor.canClear || disabled}
            onClick={() => setClearOpen(true)}
          >
            Remove pickup details
          </Button>
        )}
      </div>

      {/* The clear affordance warns what paid buyers keep (§A3): their pinned
          snapshot survives as dispute evidence and the clear unlocks their
          unilateral cancel. */}
      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent className="border-border bg-popover">
          <DialogHeader>
            <DialogTitle>Remove the pickup details?</DialogTitle>
          </DialogHeader>
          <Typography as="p" className="text-sm text-muted-foreground">
            The meeting point is deleted from the service, and buyers with paid orders are notified. Buyers who already
            paid keep the terms they were shown at payment, and each of them can cancel their order instantly. The
            version counter keeps counting — it is never reused.
          </Typography>
          <DialogFooter>
            <Button type="button" variant="secondary" className="rounded-full" onClick={() => setClearOpen(false)}>
              Keep details
            </Button>
            <Button
              type="button"
              className="rounded-full"
              onClick={() => {
                void editor.clearDetails().then((cleared) => {
                  if (cleared) setClearOpen(false);
                });
              }}
            >
              Remove details
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
});

MarketplacePickupDetailsEditor.displayName = 'MarketplacePickupDetailsEditor';

/**
 * Availability windows (§A1): authored with the details and pinned at
 * payment, shown to the buyer read-only as "when the seller is usually
 * around" — Wave 7 has no propose path; scheduling arrives in Wave 7b.
 */
function PickupAvailabilityFields({
  editor,
  disabled,
}: {
  editor: ReturnType<typeof usePickupDetailsForm>;
  disabled: boolean;
}) {
  const windows = useFieldArray({ control: editor.form.control, name: PICKUP_DETAILS_FORM_FIELDS.WINDOWS });
  const mode = editor.form.watch(PICKUP_DETAILS_FORM_FIELDS.AVAILABILITY_MODE);
  const windowsError = editor.form.formState.errors.windows;

  return (
    <div className="grid gap-3">
      <Controller
        name={PICKUP_DETAILS_FORM_FIELDS.AVAILABILITY_MODE}
        control={editor.form.control}
        render={({ field }) => (
          <div className="grid gap-2">
            <Label htmlFor="pickup-availability-mode" className={FORM_LABEL_CLASSES}>
              Availability
            </Label>
            <Select value={field.value} onValueChange={field.onChange} disabled={disabled}>
              <SelectTrigger id="pickup-availability-mode" className="h-11 w-full rounded-md border px-3">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="arrange">Arrange with the buyer after payment</SelectItem>
                <SelectItem value="windows">Weekly windows (shown read-only)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      />

      {mode === 'windows' && (
        <>
          <Typography as="p" className="text-xs text-muted-foreground">
            When you are usually around, shown to the buyer read-only after they pay — times are local to the pickup
            timezone. Agreeing a specific time happens between you and the buyer.
          </Typography>
          <div className="grid gap-3">
            {windows.fields.map((window, index) => (
              <div key={window.id} className="flex flex-wrap items-end gap-3">
                <div className="grid gap-2">
                  <Label htmlFor={`pickup-window-day-${index}`} className={FORM_LABEL_CLASSES}>
                    Day
                  </Label>
                  <Controller
                    name={`${PICKUP_DETAILS_FORM_FIELDS.WINDOWS}.${index}.day`}
                    control={editor.form.control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange} disabled={disabled}>
                        <SelectTrigger id={`pickup-window-day-${index}`} className="h-11 w-36 rounded-md border px-3">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WEEKDAY_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={`pickup-window-start-${index}`} className={FORM_LABEL_CLASSES}>
                    From
                  </Label>
                  <Input
                    id={`pickup-window-start-${index}`}
                    type="time"
                    className="h-11 w-32"
                    disabled={disabled}
                    aria-invalid={!!windowsError?.[index]?.start}
                    {...editor.form.register(`${PICKUP_DETAILS_FORM_FIELDS.WINDOWS}.${index}.start`)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={`pickup-window-end-${index}`} className={FORM_LABEL_CLASSES}>
                    To
                  </Label>
                  <Input
                    id={`pickup-window-end-${index}`}
                    type="time"
                    className="h-11 w-32"
                    disabled={disabled}
                    aria-invalid={!!windowsError?.[index]?.end}
                    {...editor.form.register(`${PICKUP_DETAILS_FORM_FIELDS.WINDOWS}.${index}.end`)}
                  />
                </div>
                {windows.fields.length > 1 && (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="rounded-full"
                    aria-label={`Remove window ${index + 1}`}
                    disabled={disabled}
                    onClick={() => windows.remove(index)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
          {typeof windowsError?.message === 'string' && (
            <Typography as="p" role="alert" className="text-sm text-destructive">
              {windowsError.message}
            </Typography>
          )}
          {Array.isArray(windowsError) && windowsError.some((entry) => entry?.end?.message) && (
            <Typography as="p" role="alert" className="text-sm text-destructive">
              {windowsError.find((entry) => entry?.end?.message)?.end?.message}
            </Typography>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid min-w-48 gap-2">
              <Label htmlFor="pickup-window-zone" className={FORM_LABEL_CLASSES}>
                Timezone
              </Label>
              <Input
                id="pickup-window-zone"
                placeholder="Europe/Berlin"
                disabled={disabled}
                aria-invalid={!!editor.form.formState.errors.zone}
                {...editor.form.register(PICKUP_DETAILS_FORM_FIELDS.ZONE)}
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="rounded-full"
              disabled={disabled || windows.fields.length >= 14}
              onClick={() => windows.append({ day: 'sat', start: '10:00', end: '14:00' })}
            >
              <Plus className="mr-2 size-4" />
              Add window
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
