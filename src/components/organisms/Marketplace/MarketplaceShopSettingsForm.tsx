'use client';

import { ImagePlus, Store, Trash2 } from 'lucide-react';
import { Controller } from 'react-hook-form';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Label } from '@/atoms/Label/Label';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Switch } from '@/atoms/Switch/Switch';
import { Typography } from '@/atoms/Typography/Typography';
import {
  type ShopImageSlot,
  useMarketplaceShopSettings,
} from '@/hooks/useMarketplaceShopSettings/useMarketplaceShopSettings';
import { ControlledInputField } from '@/molecules/ControlledInputField/ControlledInputField';
import { ControlledTextareaField } from '@/molecules/ControlledTextareaField/ControlledTextareaField';

export interface MarketplaceShopSettingsFormProps {
  onSaved?: () => void;
}

export function MarketplaceShopSettingsForm({ onSaved }: MarketplaceShopSettingsFormProps) {
  const settings = useMarketplaceShopSettings();

  return <MarketplaceShopSettingsFormView settings={settings} onSaved={onSaved} />;
}

export type MarketplaceShopSettings = ReturnType<typeof useMarketplaceShopSettings>;

export interface MarketplaceShopSettingsFormViewProps extends MarketplaceShopSettingsFormProps {
  settings: MarketplaceShopSettings;
}

export function MarketplaceShopSettingsFormView({ settings, onSaved }: MarketplaceShopSettingsFormViewProps) {
  if (settings.isLoading) {
    return <Skeleton className="h-96 w-full" />;
  }

  const submit = async () => {
    const succeeded = await settings.submit();
    if (succeeded) onSaved?.();
  };

  return (
    <Card className="border">
      <CardContent className="grid gap-5 px-6">
        <div>
          <Typography as="h2" className="text-xl font-semibold">
            {settings.hasShop ? 'Shop details and policies' : 'Create your shop'}
          </Typography>
          <Typography as="p" className="text-sm text-muted-foreground">
            {settings.hasShop
              ? `Public owner-signed storefront settings · revision ${settings.revision}`
              : 'Buyers see this on your public shop page and next to every listing you publish.'}
          </Typography>
        </div>
        <ShopImageField
          slot={settings.avatar}
          label="Shop avatar"
          description="Square image shown on your shop page and next to your listings. Metadata is stripped before publication."
          shape="avatar"
          disabled={settings.isSaving}
        />
        <ShopImageField
          slot={settings.banner}
          label="Shop banner"
          description="Wide image across the top of your shop page. Metadata is stripped before publication."
          shape="banner"
          disabled={settings.isSaving}
        />
        <ControlledInputField name="name" control={settings.form.control} label="Shop name" />
        <ControlledTextareaField name="bio" control={settings.form.control} label="Shop bio" />
        <div className="grid gap-4 sm:grid-cols-2">
          <ControlledInputField name="countryCode" control={settings.form.control} label="Country" />
          <ControlledInputField name="region" control={settings.form.control} label="Region" />
        </div>
        <ControlledTextareaField name="shippingPolicy" control={settings.form.control} label="Shipping policy" />
        <ControlledTextareaField name="returnPolicy" control={settings.form.control} label="Return policy" />
        <Controller
          name="vacationMode"
          control={settings.form.control}
          render={({ field }) => (
            <div>
              <Label className="justify-between">
                Vacation mode
                <Switch checked={field.value} onCheckedChange={field.onChange} aria-label="Vacation mode" />
              </Label>
              <Typography as="p" className="mt-1 text-sm text-muted-foreground">
                Shows a vacation notice on your shop and listings. Listings stay visible; pause them from the seller
                dashboard if you want them unavailable.
              </Typography>
            </div>
          )}
        />
        <Button className="w-full rounded-full" disabled={settings.isSaving} onClick={() => void submit()}>
          {settings.isSaving ? 'Saving…' : settings.hasShop ? 'Save shop settings' : 'Create shop'}
        </Button>
      </CardContent>
    </Card>
  );
}

function ShopImageField({
  slot,
  label,
  description,
  shape,
  disabled,
}: {
  slot: ShopImageSlot;
  label: string;
  description: string;
  shape: 'avatar' | 'banner';
  disabled: boolean;
}) {
  const { previewUrl, hasImage, error, inputRef, choose, onInputChange, remove } = slot;
  const errorMessage =
    error === 'invalid-type'
      ? 'Choose an image file (JPEG, PNG, or WebP).'
      : error === 'too-large'
        ? 'This image is too large.'
        : null;

  return (
    <div>
      <Typography as="p" className="text-sm font-medium">
        {label}
      </Typography>
      <Typography as="p" className="mt-1 text-sm text-muted-foreground">
        {description}
      </Typography>
      <div className="mt-3 flex items-center gap-4">
        <div
          className={
            shape === 'avatar'
              ? 'flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl border bg-muted text-muted-foreground'
              : 'flex h-20 w-full max-w-60 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted text-muted-foreground'
          }
        >
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- homeserver media and object URLs bypass Next image optimization
            <img src={previewUrl} alt={`${label} preview`} className="size-full object-cover object-center" />
          ) : (
            <Store className="size-8" aria-hidden />
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="rounded-full"
            disabled={disabled}
            onClick={choose}
          >
            <ImagePlus className="mr-2 size-4" />
            {hasImage ? `Replace ${shape}` : `Add ${shape}`}
          </Button>
          {hasImage && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="rounded-full"
              disabled={disabled}
              onClick={remove}
            >
              <Trash2 className="mr-2 size-4" />
              Remove
            </Button>
          )}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        aria-label={`Choose ${label.toLowerCase()} image`}
        onChange={onInputChange}
      />
      {errorMessage && (
        <Typography as="p" role="alert" className="mt-2 text-sm text-destructive">
          {errorMessage}
        </Typography>
      )}
    </div>
  );
}
