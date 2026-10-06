'use client';

import { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, Package, Pencil, Plus, Trash2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { useMarketplaceShippingIntegration } from '@/hooks/useMarketplaceShippingIntegration/useMarketplaceShippingIntegration';
import {
  bareShippingPresetId,
  useMarketplaceShippingPresets,
} from '@/hooks/useMarketplaceShippingPresets/useMarketplaceShippingPresets';
import { formatCommerceMoney } from '@/libs/commerce/format';
import { isPlausibleShippoApiKey, type ShipFromAddress } from '@/libs/commerce/shipping';
import type { CommerceShippingPresetModelSchema } from '@/models/commerce/commerce.schema';
import { ControlledInputField } from '@/molecules/ControlledInputField/ControlledInputField';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';

const shippoFormSchema = z.object({
  shippoApiKey: z
    .string()
    .trim()
    .refine(
      (value) => value === '' || isPlausibleShippoApiKey(value),
      'Shippo API tokens start with shippo_ (from your Shippo account settings).',
    ),
  fromName: z.string().trim().min(1, 'Required.').max(100),
  fromLine1: z.string().trim().min(1, 'Required.').max(200),
  fromLine2: z.string().trim().max(200),
  fromCity: z.string().trim().min(1, 'Required.').max(100),
  fromRegion: z.string().trim().max(100),
  fromPostalCode: z.string().trim().min(1, 'Required.').max(20),
  fromCountryCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'Two-letter country code (e.g. US, HR).'),
  fromPhone: z.string().trim().max(30),
  fromEmail: z.string().trim().max(100),
});

type ShippoFormData = z.infer<typeof shippoFormSchema>;

const shippoFormDefaults: ShippoFormData = {
  shippoApiKey: '',
  fromName: '',
  fromLine1: '',
  fromLine2: '',
  fromCity: '',
  fromRegion: '',
  fromPostalCode: '',
  fromCountryCode: '',
  fromPhone: '',
  fromEmail: '',
};

function shipFromToForm(shipFrom: ShipFromAddress): Omit<ShippoFormData, 'shippoApiKey'> {
  return {
    fromName: shipFrom.name,
    fromLine1: shipFrom.line1,
    fromLine2: shipFrom.line2,
    fromCity: shipFrom.city,
    fromRegion: shipFrom.region,
    fromPostalCode: shipFrom.postalCode,
    fromCountryCode: shipFrom.countryCode,
    fromPhone: shipFrom.phone,
    fromEmail: shipFrom.email,
  };
}

/** The Shippo integration card: seller-owned token + ship-from address. */
function ShippoIntegrationCard() {
  const shipping = useMarketplaceShippingIntegration();
  const form = useForm<ShippoFormData>({
    resolver: zodResolver(shippoFormSchema),
    defaultValues: shippoFormDefaults,
    mode: 'onChange',
  });

  useEffect(() => {
    if (shipping.config?.shipFrom) {
      form.reset({ shippoApiKey: '', ...shipFromToForm(shipping.config.shipFrom) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shipping.config]);

  if (!shipping.enabled) return null;

  const submit = form.handleSubmit(async (data) => {
    const saved = await shipping.save({
      // Empty means "keep the stored token" (it is write-only server-side).
      ...(data.shippoApiKey ? { shippoApiKey: data.shippoApiKey } : {}),
      shipFrom: {
        name: data.fromName,
        line1: data.fromLine1,
        line2: data.fromLine2,
        city: data.fromCity,
        region: data.fromRegion,
        postalCode: data.fromPostalCode,
        countryCode: data.fromCountryCode.toUpperCase(),
        phone: data.fromPhone,
        email: data.fromEmail,
      },
    });
    if (saved) form.setValue('shippoApiKey', '');
  });

  return (
    <Card className="border">
      <CardContent className="grid gap-4 px-6">
        <div>
          <div className="flex items-center gap-2">
            <Typography as="h2" className="text-xl font-semibold">
              Shippo integration
            </Typography>
            {shipping.config?.shippoApiKeySet && <Badge variant="secondary">Token saved</Badge>}
          </div>
          <Typography as="p" className="mt-1 text-sm text-muted-foreground">
            Buy real shipping labels for paid orders with your own Shippo account. The API token is yours (Shippo
            settings → API), stored sealed and never readable back; labels are charged by Shippo to your account — this
            marketplace never touches the money.
          </Typography>
        </div>
        {shipping.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <ControlledInputField
              name="shippoApiKey"
              control={form.control}
              label={shipping.config?.shippoApiKeySet ? 'Replace Shippo API token (optional)' : 'Shippo API token'}
              placeholder="shippo_live_…"
            />
            <Typography as="h3" className="mt-1 font-semibold">
              Ship-from address
            </Typography>
            <div className="grid gap-4 sm:grid-cols-2">
              <ControlledInputField
                name="fromName"
                control={form.control}
                label="Name"
                placeholder="Igor's Olive Farm"
              />
              <ControlledInputField name="fromLine1" control={form.control} label="Street" placeholder="Maslinska 1" />
              <ControlledInputField name="fromLine2" control={form.control} label="Street line 2 (optional)" />
              <ControlledInputField name="fromCity" control={form.control} label="City" placeholder="Split" />
              <ControlledInputField name="fromRegion" control={form.control} label="Region/State (optional)" />
              <ControlledInputField
                name="fromPostalCode"
                control={form.control}
                label="Postal code"
                placeholder="21000"
              />
              <ControlledInputField
                name="fromCountryCode"
                control={form.control}
                label="Country code"
                placeholder="HR"
              />
              <ControlledInputField name="fromPhone" control={form.control} label="Phone (optional)" />
              <ControlledInputField name="fromEmail" control={form.control} label="Email (optional)" />
            </div>
            <Button className="w-fit rounded-full" disabled={shipping.isSaving} onClick={() => void submit()}>
              Save Shippo settings
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

const presetFormSchema = z
  .object({
    shippingLabel: z
      .string()
      .trim()
      .min(1, 'Give the shipping option a label.')
      .max(100, 'Keep the label under 100 characters.'),
    shippingPrice: z
      .string()
      .trim()
      .regex(/^\d+(?:\.\d{1,2})?$/, 'Enter a valid USD amount with at most two decimal places.')
      .refine((value) => Number(value) > 0, 'Price must be greater than zero.'),
    shippingMinDays: z
      .string()
      .trim()
      .regex(/^\d+$/, 'Enter whole days.')
      .refine((value) => Number(value) <= 365, 'Estimates are capped at 365 days.'),
    shippingMaxDays: z
      .string()
      .trim()
      .regex(/^\d+$/, 'Enter whole days.')
      .refine((value) => Number(value) <= 365, 'Estimates are capped at 365 days.'),
  })
  .superRefine((data, context) => {
    if (/^\d+$/.test(data.shippingMinDays) && /^\d+$/.test(data.shippingMaxDays)) {
      if (Number(data.shippingMaxDays) < Number(data.shippingMinDays)) {
        context.addIssue({
          code: 'custom',
          path: ['shippingMaxDays'],
          message: 'The maximum estimate cannot precede the minimum.',
        });
      }
    }
  });

type PresetFormData = z.infer<typeof presetFormSchema>;

const presetFormDefaults: PresetFormData = {
  shippingLabel: '',
  shippingPrice: '',
  shippingMinDays: '3',
  shippingMaxDays: '7',
};

export function MarketplaceShippingSettings() {
  const { presets, isLoading, saveFromFields, remove } = useMarketplaceShippingPresets();
  // null: list only; 'new': creating; otherwise the composite id being edited.
  const [editingId, setEditingId] = useState<string | null>(null);
  const form = useForm<PresetFormData>({
    resolver: zodResolver(presetFormSchema),
    defaultValues: presetFormDefaults,
    mode: 'onChange',
  });

  const beginCreate = () => {
    form.reset(presetFormDefaults);
    setEditingId('new');
  };

  const beginEdit = (preset: CommerceShippingPresetModelSchema) => {
    form.reset({
      shippingLabel: preset.label,
      shippingPrice: (preset.price_minor / 100).toFixed(2),
      shippingMinDays: String(preset.estimated_min_days),
      shippingMaxDays: String(preset.estimated_max_days),
    });
    setEditingId(preset.id);
  };

  const submit = form.handleSubmit(async (data) => {
    const editing = presets.find(({ id }) => id === editingId);
    if (await saveFromFields(editing ? bareShippingPresetId(editing) : null, data)) {
      form.reset(presetFormDefaults);
      setEditingId(null);
    }
  });

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28"
      classNameWrapperContent="max-w-7xl"
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6 px-4 sm:px-6">
        <Link
          href={MARKETPLACE_ROUTES.DASHBOARD}
          overrideDefaults
          className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground"
        >
          <ArrowLeft className="size-4" />
          Seller studio
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Badge className="mb-4">Seller studio</Badge>
            <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
              Shipping
            </Heading>
            <Typography as="p" className="mt-2 max-w-xl text-muted-foreground">
              Your Shippo label integration, plus reusable presets for the sell studio&apos;s shipping fields (label,
              flat price, delivery estimate). Presets are stored on this device only — applying one just pre-fills the
              form, and listings publish exactly as before.
            </Typography>
          </div>
          {editingId === null && (
            <Button className="rounded-full" onClick={beginCreate}>
              <Plus className="mr-2 size-4" />
              Add preset
            </Button>
          )}
        </div>

        <ShippoIntegrationCard />

        {editingId !== null && (
          <Card className="border">
            <CardContent className="grid gap-4 px-6">
              <Typography as="h2" className="text-xl font-semibold">
                {editingId === 'new' ? 'New preset' : 'Edit preset'}
              </Typography>
              <ControlledInputField
                name="shippingLabel"
                control={form.control}
                label="Shipping label"
                placeholder="Standard shipping"
              />
              <div className="grid gap-4 sm:grid-cols-3">
                <ControlledInputField
                  name="shippingPrice"
                  control={form.control}
                  label="Flat price (USD)"
                  placeholder="12.00"
                />
                <ControlledInputField name="shippingMinDays" control={form.control} label="Min days" placeholder="3" />
                <ControlledInputField name="shippingMaxDays" control={form.control} label="Max days" placeholder="7" />
              </div>
              <div className="flex gap-2">
                <Button className="rounded-full" onClick={() => void submit()}>
                  Save preset
                </Button>
                <Button variant="secondary" className="rounded-full" onClick={() => setEditingId(null)}>
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : presets.length ? (
          <div className="grid gap-3">
            {presets.map((preset) => (
              <Card key={preset.id} className="border py-4">
                <CardContent className="flex flex-wrap items-center justify-between gap-4 px-5">
                  <div className="min-w-0">
                    <Typography as="h2" className="font-semibold">
                      {preset.label}
                    </Typography>
                    <Typography as="p" className="mt-1 text-sm text-muted-foreground">
                      {formatCommerceMoney({
                        amountMinor: preset.price_minor,
                        currency: preset.currency,
                        exponent: 2,
                      })}{' '}
                      flat · {preset.estimated_min_days}–{preset.estimated_max_days} days
                    </Typography>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="rounded-full"
                      aria-label={`Edit ${preset.label}`}
                      onClick={() => beginEdit(preset)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="rounded-full"
                      aria-label={`Delete ${preset.label}`}
                      onClick={() => void remove(preset)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : editingId === null ? (
          <div className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed text-center">
            <Package className="mb-3 size-10 text-muted-foreground" />
            <Heading level={2} size="md">
              No shipping presets
            </Heading>
            <Typography as="p" className="mt-2 max-w-md text-sm text-muted-foreground">
              Create one here, or use &quot;Save as preset&quot; in the sell studio&apos;s shipping section.
            </Typography>
          </div>
        ) : null}
      </Container>
    </ContentLayout>
  );
}
