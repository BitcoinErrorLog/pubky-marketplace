'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Controller, type FieldValues, type Path, useWatch } from 'react-hook-form';
import { Container } from '@/atoms/Container/Container';
import { Label } from '@/atoms/Label/Label';
import { getCommerceAdapterMode, getMarketplaceUrl, isDurableCommerceMode } from '@/config/commerce';
import { FORM_LABEL_CLASSES } from '@/config/forms';
import {
  ADDRESS_ATTRIBUTION,
  ADDRESS_SUGGEST_MIN_CHARS,
  type AddressAutocompleteProvider,
  type AddressSuggestion,
  createMarketplaceAddressProvider,
} from '@/libs/commerce/address-autocomplete';
import {
  canonicalizeRegion,
  filterSubdivisions,
  postalLabelForCountry,
  regionLabelForCountry,
  subdivisionsForCountry,
} from '@/libs/commerce/postal-address';
import { lookupUsZip } from '@/libs/commerce/us-zip-lookup';
import { cn } from '@/libs/utils/utils';
import { ControlledInputField } from '@/molecules/ControlledInputField/ControlledInputField';
import { InputField } from '@/molecules/InputField/InputField';
import type { MarketplaceAddressFieldsProps } from './MarketplaceAddressFields.types';

const SUGGEST_DEBOUNCE_MS = 300;

function readDefaultProvider(): AddressAutocompleteProvider | null {
  if (typeof process !== 'undefined' && process.env.VITEST) return null;
  try {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) return null;
    const url = getMarketplaceUrl();
    return url ? createMarketplaceAddressProvider(url) : null;
  } catch {
    return null;
  }
}

function SuggestionList({
  id,
  testId,
  items,
  activeIndex,
  onSelect,
  onHover,
  className,
}: {
  id: string;
  testId: string;
  items: Array<{ id: string; primary: string; secondary?: string }>;
  activeIndex: number;
  onSelect: (id: string) => void;
  onHover: (index: number) => void;
  className?: string;
}) {
  return (
    <ul
      id={id}
      role="listbox"
      data-testid={testId}
      className={cn(
        'absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-popover py-1 shadow-md',
        className,
      )}
    >
      {items.map((item, index) => (
        <li
          key={item.id}
          id={`${id}-option-${index}`}
          role="option"
          aria-selected={index === activeIndex}
          className={cn(
            'cursor-pointer px-3 py-2 text-sm text-popover-foreground',
            index === activeIndex && 'bg-accent',
          )}
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(item.id);
          }}
          onMouseEnter={() => onHover(index)}
        >
          <span className="font-medium">{item.primary}</span>
          {item.secondary ? <span className="mt-0.5 block text-xs text-muted-foreground">{item.secondary}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function MarketplaceAddressFields<T extends FieldValues>({
  control,
  setValue,
  disabled = false,
  autocompleteProvider,
}: MarketplaceAddressFieldsProps<T>) {
  const countryCode = String(useWatch({ control, name: 'countryCode' as Path<T> }) ?? '');
  const line1 = String(useWatch({ control, name: 'line1' as Path<T> }) ?? '');
  const regionValue = String(useWatch({ control, name: 'region' as Path<T> }) ?? '');
  const cityValue = String(useWatch({ control, name: 'city' as Path<T> }) ?? '');
  const postalCode = String(useWatch({ control, name: 'postalCode' as Path<T> }) ?? '');
  const country = countryCode.trim().toUpperCase();
  const regionLabel = regionLabelForCountry(country);
  const postalLabel = postalLabelForCountry(country);
  const closedList = subdivisionsForCountry(country);
  const [defaultProvider] = useState<AddressAutocompleteProvider | null>(readDefaultProvider);
  const provider = autocompleteProvider !== undefined ? autocompleteProvider : defaultProvider;
  const autocompleteEnabled = /^[A-Z]{2}$/.test(country) && provider !== null;
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [suggestionsUnavailable, setSuggestionsUnavailable] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIndex, setSuggestIndex] = useState(-1);
  const [regionQueryOpen, setRegionQueryOpen] = useState(false);
  const [regionActiveIndex, setRegionActiveIndex] = useState(0);
  const suggestRequestRef = useRef(0);
  const appliedLine1Ref = useRef<string | null>(null);
  const listId = useId();
  const suggestionListId = `${listId}-address-suggestions`;
  const regionListId = `${listId}-region-options`;
  const regionOptions = closedList ? filterSubdivisions(country, regionValue) : [];

  useEffect(() => {
    const requestId = ++suggestRequestRef.current;
    const trimmed = line1.trim();
    if (!autocompleteEnabled || !provider || trimmed.length < ADDRESS_SUGGEST_MIN_CHARS) {
      setSuggestions([]);
      setSuggestOpen(false);
      setSuggestionsUnavailable(false);
      return;
    }
    if (trimmed === appliedLine1Ref.current) return;
    appliedLine1Ref.current = null;
    const controller = new AbortController();
    const handle = window.setTimeout(() => {
      void provider.suggest(trimmed, { countryCode: country, signal: controller.signal }).then(
        (result) => {
          if (requestId !== suggestRequestRef.current) return;
          if (result.status === 'unavailable') {
            setSuggestions([]);
            setSuggestOpen(false);
            setSuggestionsUnavailable(true);
            return;
          }
          setSuggestionsUnavailable(false);
          setSuggestions(result.suggestions);
          setSuggestOpen(result.suggestions.length > 0);
          setSuggestIndex(result.suggestions.length > 0 ? 0 : -1);
        },
        () => {
          if (requestId !== suggestRequestRef.current) return;
          setSuggestions([]);
          setSuggestOpen(false);
          setSuggestionsUnavailable(true);
        },
      );
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(handle);
      controller.abort();
    };
  }, [autocompleteEnabled, country, line1, provider]);

  useEffect(() => {
    if (country !== 'US') return;
    const fill = lookupUsZip(postalCode);
    if (!fill) return;
    if (!cityValue.trim() && fill.city) {
      setValue('city' as Path<T>, fill.city as T[Path<T>], { shouldValidate: true, shouldDirty: true });
    }
    if (!regionValue.trim() && fill.region) {
      setValue('region' as Path<T>, fill.region as T[Path<T>], { shouldValidate: true, shouldDirty: true });
    }
  }, [country, postalCode, cityValue, regionValue, setValue]);

  const applySuggestion = (id: string) => {
    const suggestion = suggestions.find((item) => item.id === id);
    setSuggestions([]);
    setSuggestOpen(false);
    if (!suggestion) return;
    const { address } = suggestion;
    appliedLine1Ref.current = address.line1.trim();
    setValue('line1' as Path<T>, address.line1 as T[Path<T>], { shouldValidate: true, shouldDirty: true });
    if (address.city) {
      setValue('city' as Path<T>, address.city as T[Path<T>], { shouldValidate: true, shouldDirty: true });
    }
    const region = canonicalizeRegion(country, address.region);
    const knownRegion = !closedList || closedList.some((option) => option.code === region);
    if (region && knownRegion) {
      setValue('region' as Path<T>, region as T[Path<T>], { shouldValidate: true, shouldDirty: true });
    }
    if (address.postalCode) {
      setValue('postalCode' as Path<T>, address.postalCode as T[Path<T>], {
        shouldValidate: true,
        shouldDirty: true,
      });
    }
  };

  const commitRegion = (raw: string) => {
    const trimmed = raw.trim();
    if (closedList) {
      const matches = filterSubdivisions(country, trimmed);
      if (matches.length === 1) {
        setValue('region' as Path<T>, matches[0].code as T[Path<T>], { shouldValidate: true, shouldDirty: true });
        setRegionQueryOpen(false);
        return;
      }
    }
    setValue('region' as Path<T>, canonicalizeRegion(country, raw) as T[Path<T>], {
      shouldValidate: true,
      shouldDirty: true,
    });
    setRegionQueryOpen(false);
  };

  return (
    <div className="grid gap-4" data-surface="marketplace-address-fields">
      {/* Country comes first: the address suggestions, region list and postal rules all follow it. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Controller
          name={'countryCode' as Path<T>}
          control={control}
          render={({ field, fieldState }) => (
            <Container className="gap-2">
              <Label htmlFor="countryCode" className={FORM_LABEL_CLASSES}>
                Country
              </Label>
              <InputField
                id="countryCode"
                name={field.name}
                value={field.value ?? ''}
                onChange={(event) => {
                  const next = event.target.value.toUpperCase();
                  field.onChange(next);
                  const nextList = subdivisionsForCountry(next);
                  if (
                    nextList &&
                    regionValue &&
                    !nextList.some((option) => option.code === canonicalizeRegion(next, regionValue))
                  ) {
                    setValue('region' as Path<T>, '' as T[Path<T>], { shouldValidate: true, shouldDirty: true });
                  }
                }}
                onBlur={field.onBlur}
                disabled={disabled}
                variant="dashed"
                size="lg"
                className="mb-0"
                maxLength={2}
                autoComplete="country"
                status={fieldState.error ? 'error' : 'default'}
                message={fieldState.error?.message}
                messageType={fieldState.error ? 'error' : 'default'}
              />
            </Container>
          )}
        />
      </div>
      <Controller
        name={'line1' as Path<T>}
        control={control}
        render={({ field, fieldState }) => (
          <Container className="relative gap-2">
            <Label htmlFor="line1" className={FORM_LABEL_CLASSES}>
              Address line 1
            </Label>
            <InputField
              id="line1"
              name={field.name}
              value={field.value ?? ''}
              onChange={field.onChange}
              onBlur={() => {
                field.onBlur();
                window.setTimeout(() => setSuggestOpen(false), 120);
              }}
              disabled={disabled}
              variant="dashed"
              size="lg"
              className="mb-0"
              status={fieldState.error ? 'error' : 'default'}
              message={fieldState.error?.message}
              messageType={fieldState.error ? 'error' : 'default'}
              autoComplete={autocompleteEnabled ? 'off' : 'address-line1'}
              role={autocompleteEnabled ? 'combobox' : undefined}
              aria-expanded={autocompleteEnabled ? suggestOpen : undefined}
              aria-controls={autocompleteEnabled ? suggestionListId : undefined}
              aria-autocomplete={autocompleteEnabled ? 'list' : undefined}
              aria-haspopup={autocompleteEnabled ? 'listbox' : undefined}
              aria-activedescendant={
                autocompleteEnabled && suggestOpen && suggestIndex >= 0
                  ? `${suggestionListId}-option-${suggestIndex}`
                  : undefined
              }
              onKeyDown={(event) => {
                if (!suggestOpen || suggestions.length === 0) return;
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setSuggestIndex((index) => (index + 1) % suggestions.length);
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setSuggestIndex((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
                } else if (event.key === 'Enter' && suggestIndex >= 0) {
                  event.preventDefault();
                  applySuggestion(suggestions[suggestIndex].id);
                } else if (event.key === 'Escape') {
                  setSuggestOpen(false);
                }
              }}
            />
            {autocompleteEnabled ? (
              <p className="text-xs text-muted-foreground" data-testid="marketplace-address-attribution">
                Address suggestions{' '}
                <a
                  href={ADDRESS_ATTRIBUTION.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2"
                >
                  {ADDRESS_ATTRIBUTION.text}
                </a>
              </p>
            ) : null}
            {autocompleteEnabled && suggestionsUnavailable ? (
              <p role="status" className="text-xs text-muted-foreground" data-testid="marketplace-address-unavailable">
                Address suggestions are unavailable. Enter the address manually.
              </p>
            ) : null}
            {suggestOpen && suggestions.length > 0 ? (
              <SuggestionList
                id={suggestionListId}
                testId="marketplace-address-suggestions"
                items={suggestions.map((suggestion) => ({
                  id: suggestion.id,
                  primary: suggestion.primary,
                  secondary: suggestion.secondary,
                }))}
                activeIndex={suggestIndex}
                onSelect={applySuggestion}
                onHover={setSuggestIndex}
                className="top-full"
              />
            ) : null}
          </Container>
        )}
      />
      <ControlledInputField name={'line2' as Path<T>} control={control} label="Address line 2" disabled={disabled} />
      <div className="grid gap-4 sm:grid-cols-2">
        <ControlledInputField name={'city' as Path<T>} control={control} label="City" disabled={disabled} />
        <Controller
          name={'region' as Path<T>}
          control={control}
          render={({ field, fieldState }) => (
            <Container className="relative gap-2">
              <Label htmlFor="region" className={FORM_LABEL_CLASSES}>
                {regionLabel}
              </Label>
              <InputField
                id="region"
                name={field.name}
                value={field.value ?? ''}
                onChange={(event) => {
                  field.onChange(event);
                  if (closedList) {
                    setRegionQueryOpen(true);
                    setRegionActiveIndex(0);
                  }
                }}
                onFocus={() => {
                  if (closedList) setRegionQueryOpen(true);
                }}
                onBlur={() => {
                  field.onBlur();
                  if (closedList) commitRegion(String(field.value ?? ''));
                }}
                disabled={disabled}
                variant="dashed"
                size="lg"
                className="mb-0"
                placeholder={closedList ? `Select or type a ${regionLabel.toLowerCase()}` : undefined}
                status={fieldState.error ? 'error' : 'default'}
                message={fieldState.error?.message}
                messageType={fieldState.error ? 'error' : 'default'}
                autoComplete="address-level1"
                role={closedList ? 'combobox' : undefined}
                aria-expanded={closedList ? regionQueryOpen : undefined}
                aria-controls={closedList ? regionListId : undefined}
                aria-autocomplete={closedList ? 'list' : undefined}
                aria-haspopup={closedList ? 'listbox' : undefined}
                aria-activedescendant={
                  closedList && regionQueryOpen && regionOptions[regionActiveIndex]
                    ? `${regionListId}-option-${regionActiveIndex}`
                    : undefined
                }
                onKeyDown={(event) => {
                  if (!closedList || regionOptions.length === 0) return;
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setRegionQueryOpen(true);
                    setRegionActiveIndex((index) => (index + 1) % regionOptions.length);
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setRegionActiveIndex((index) => (index <= 0 ? regionOptions.length - 1 : index - 1));
                  } else if (event.key === 'Enter' && regionQueryOpen) {
                    event.preventDefault();
                    commitRegion(regionOptions[regionActiveIndex]?.code ?? String(field.value ?? ''));
                  } else if (event.key === 'Escape') {
                    setRegionQueryOpen(false);
                  }
                }}
              />
              {closedList && regionQueryOpen && regionOptions.length > 0 ? (
                <SuggestionList
                  id={regionListId}
                  testId="marketplace-region-options"
                  items={regionOptions.map((option) => ({
                    id: option.code,
                    primary: option.name,
                    secondary: option.code,
                  }))}
                  activeIndex={regionActiveIndex}
                  onSelect={commitRegion}
                  onHover={setRegionActiveIndex}
                />
              ) : null}
            </Container>
          )}
        />
        <ControlledInputField
          name={'postalCode' as Path<T>}
          control={control}
          label={postalLabel}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
