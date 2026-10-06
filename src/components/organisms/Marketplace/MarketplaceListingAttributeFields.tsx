'use client';

import { Controller, type UseFormReturn, useWatch } from 'react-hook-form';
import { Button } from '@/atoms/Button/Button';
import { Container } from '@/atoms/Container/Container';
import { Input } from '@/atoms/Input/Input';
import { Label } from '@/atoms/Label/Label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/atoms/Select/Select';
import { Typography } from '@/atoms/Typography/Typography';
import { FORM_LABEL_CLASSES } from '@/config/forms';
import {
  COMMERCE_BRAND_SUGGESTIONS,
  type CommerceAttributeField,
  commerceAttributeFieldsFor,
} from '@/config/taxonomy/taxonomy';
import {
  CREATE_MARKETPLACE_LISTING_FIELDS,
  type CreateMarketplaceListingData,
  listingAttributeFormField,
} from '@/hooks/useCreateMarketplaceListing/useCreateMarketplaceListing.types';

/** Radix selects cannot hold an empty-string item, so optional selects map this sentinel to "". */
const NOT_SPECIFIED = '__not_specified__';

export interface MarketplaceListingAttributeFieldsProps {
  form: UseFormReturn<CreateMarketplaceListingData>;
  isPublishing: boolean;
}

/**
 * The category-dependent "item specifics" block of the sell/edit studio:
 * once a category is chosen, the attribute fields its taxonomy entry defines
 * appear (size is required for fashion leaves with a size chart; everything
 * else is optional). Attributes on foreign records that this form cannot
 * express are preserved outside the form (see `partitionListingAttributes`).
 */
export function MarketplaceListingAttributeFields({ form, isPublishing }: MarketplaceListingAttributeFieldsProps) {
  const categoryId = useWatch({ control: form.control, name: CREATE_MARKETPLACE_LISTING_FIELDS.CATEGORY });
  const fields = categoryId ? commerceAttributeFieldsFor(categoryId) : [];
  if (fields.length === 0) return null;

  return (
    <div className="flex flex-col gap-4" data-cy="marketplace-listing-attributes">
      <div>
        <Typography as="h3" className="font-semibold">
          Item specifics
        </Typography>
        <Typography as="p" className="text-sm text-muted-foreground">
          Details buyers expect for this category. Only filled-in fields are published.
        </Typography>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        {fields.map((field) => (
          <AttributeField key={field.key} field={field} form={form} isPublishing={isPublishing} />
        ))}
      </div>
    </div>
  );
}

function AttributeField({
  field,
  form,
  isPublishing,
}: {
  field: CommerceAttributeField;
  form: UseFormReturn<CreateMarketplaceListingData>;
  isPublishing: boolean;
}) {
  const formField = listingAttributeFormField(field.key);
  if (!formField) return null;

  switch (field.input) {
    case 'select':
      return <AttributeSelect field={field} form={form} formField={formField} isPublishing={isPublishing} />;
    case 'multi-select':
      return <AttributeMultiSelect field={field} form={form} formField={formField} isPublishing={isPublishing} />;
    case 'brand':
      return <AttributeBrandInput field={field} form={form} formField={formField} isPublishing={isPublishing} />;
    case 'text':
      return <AttributeTextInput field={field} form={form} formField={formField} isPublishing={isPublishing} />;
  }
}

interface AttributeInputProps {
  field: CommerceAttributeField;
  form: UseFormReturn<CreateMarketplaceListingData>;
  formField: string;
  isPublishing: boolean;
}

function AttributeSelect({ field, form, formField, isPublishing }: AttributeInputProps) {
  const inputId = `marketplace-attribute-${field.key}`;
  return (
    <Container className="gap-2">
      <Label htmlFor={inputId} className={FORM_LABEL_CLASSES}>
        {field.label}
        {!field.required && ' (optional)'}
      </Label>
      <Controller
        name={formField as typeof CREATE_MARKETPLACE_LISTING_FIELDS.ATTR_SIZE}
        control={form.control}
        render={({ field: controller, fieldState }) => (
          <>
            <Select
              value={controller.value === '' ? undefined : controller.value}
              onValueChange={(value) => controller.onChange(value === NOT_SPECIFIED ? '' : value)}
              disabled={isPublishing}
            >
              <SelectTrigger
                id={inputId}
                className="h-11 w-full rounded-md border px-3"
                aria-invalid={!!fieldState.error}
              >
                <SelectValue placeholder={field.required ? `Choose a ${field.label.toLowerCase()}` : 'Not specified'} />
              </SelectTrigger>
              <SelectContent>
                {!field.required && <SelectItem value={NOT_SPECIFIED}>Not specified</SelectItem>}
                {(field.options ?? []).map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fieldState.error && (
              <Typography as="p" role="alert" className="text-sm text-destructive">
                {fieldState.error.message}
              </Typography>
            )}
          </>
        )}
      />
    </Container>
  );
}

function AttributeMultiSelect({ field, form, formField, isPublishing }: AttributeInputProps) {
  return (
    <Container className="gap-2 sm:col-span-2">
      <Label className={FORM_LABEL_CLASSES}>
        {field.label} (optional, up to {field.maxValues})
      </Label>
      <Controller
        name={formField as typeof CREATE_MARKETPLACE_LISTING_FIELDS.ATTR_COLORS}
        control={form.control}
        render={({ field: controller, fieldState }) => {
          const selected: string[] = controller.value ?? [];
          const toggle = (value: string) => {
            if (selected.includes(value)) {
              controller.onChange(selected.filter((entry) => entry !== value));
            } else if (field.maxValues === undefined || selected.length < field.maxValues) {
              controller.onChange([...selected, value]);
            }
          };
          return (
            <>
              <div
                role="group"
                aria-label={field.label}
                className="flex flex-wrap gap-2"
                data-cy={`marketplace-attribute-${field.key}`}
              >
                {(field.options ?? []).map((option) => {
                  const isSelected = selected.includes(option.value);
                  const isAtLimit = !isSelected && field.maxValues !== undefined && selected.length >= field.maxValues;
                  return (
                    <Button
                      key={option.value}
                      type="button"
                      size="sm"
                      variant={isSelected ? 'default' : 'secondary'}
                      className="rounded-full"
                      aria-pressed={isSelected}
                      disabled={isPublishing || isAtLimit}
                      onClick={() => toggle(option.value)}
                    >
                      {option.label}
                    </Button>
                  );
                })}
              </div>
              {fieldState.error && (
                <Typography as="p" role="alert" className="text-sm text-destructive">
                  {fieldState.error.message}
                </Typography>
              )}
            </>
          );
        }}
      />
    </Container>
  );
}

function AttributeBrandInput({ field, form, formField, isPublishing }: AttributeInputProps) {
  const inputId = `marketplace-attribute-${field.key}`;
  const datalistId = `${inputId}-suggestions`;
  return (
    <Container className="gap-2">
      <Label htmlFor={inputId} className={FORM_LABEL_CLASSES}>
        {field.label} (optional)
      </Label>
      <Controller
        name={formField as typeof CREATE_MARKETPLACE_LISTING_FIELDS.ATTR_BRAND}
        control={form.control}
        render={({ field: controller, fieldState }) => (
          <>
            <Input
              id={inputId}
              list={datalistId}
              value={controller.value}
              placeholder="Start typing for suggestions, or enter any brand"
              disabled={isPublishing}
              aria-invalid={!!fieldState.error}
              onChange={(event) => controller.onChange(event.target.value)}
            />
            <datalist id={datalistId}>
              {COMMERCE_BRAND_SUGGESTIONS.map((brand) => (
                <option key={brand.value} value={brand.label} />
              ))}
            </datalist>
            {fieldState.error && (
              <Typography as="p" role="alert" className="text-sm text-destructive">
                {fieldState.error.message}
              </Typography>
            )}
          </>
        )}
      />
    </Container>
  );
}

function AttributeTextInput({ field, form, formField, isPublishing }: AttributeInputProps) {
  const inputId = `marketplace-attribute-${field.key}`;
  const placeholder =
    field.key === 'model'
      ? 'e.g. AE-1 Program'
      : field.key === 'medium'
        ? 'e.g. Oil on canvas'
        : field.key === 'author'
          ? 'e.g. Ursula K. Le Guin'
          : field.key === 'format'
            ? 'e.g. Hardcover, LP, Blu-ray'
            : field.key === 'material'
              ? 'e.g. Sterling silver'
              : '';
  return (
    <Container className="gap-2">
      <Label htmlFor={inputId} className={FORM_LABEL_CLASSES}>
        {field.label} (optional)
      </Label>
      <Controller
        name={formField as typeof CREATE_MARKETPLACE_LISTING_FIELDS.ATTR_MODEL}
        control={form.control}
        render={({ field: controller, fieldState }) => (
          <>
            <Input
              id={inputId}
              value={controller.value}
              placeholder={placeholder}
              disabled={isPublishing}
              aria-invalid={!!fieldState.error}
              onChange={(event) => controller.onChange(event.target.value)}
            />
            {fieldState.error && (
              <Typography as="p" role="alert" className="text-sm text-destructive">
                {fieldState.error.message}
              </Typography>
            )}
          </>
        )}
      />
    </Container>
  );
}
