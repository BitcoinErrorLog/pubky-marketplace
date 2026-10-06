'use client';

import { Badge } from '@/atoms/Badge/Badge';
import { Container } from '@/atoms/Container/Container';
import { Label } from '@/atoms/Label/Label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/atoms/Select/Select';
import { Typography } from '@/atoms/Typography/Typography';
import { FORM_LABEL_CLASSES } from '@/config/forms';
import {
  commerceCategoryChildren,
  commerceCategoryPathLabels,
  type CommerceTaxonomyNode,
  resolveCommerceCategory,
} from '@/config/taxonomy/taxonomy';

export interface MarketplaceCategoryPickerProps {
  value: string;
  onChange: (categoryId: string) => void;
  disabled: boolean;
  error?: string;
}

/**
 * Cascading category selects over the taxonomy tree. Picking at any level
 * immediately stores that node's id (dropping deeper picks); further selects
 * appear while the chosen node still has children. Records hydrated with a
 * legacy or unknown category keep their published id until the seller picks
 * something else — the stored category is shown as a breadcrumb so nothing
 * is silently re-labeled.
 */
export function MarketplaceCategoryPicker({ value, onChange, disabled, error }: MarketplaceCategoryPickerProps) {
  const resolved = value ? resolveCommerceCategory(value) : null;
  // Legacy nodes are not offered by the selects, so the cascade renders from
  // their deepest non-legacy ancestor while the stored id stays untouched.
  const cascadePath = resolved ? resolved.path.filter((node) => !node.legacy) : [];
  const isLegacyOrUnknown = value !== '' && (resolved === null || resolved.node.legacy === true);

  const levels: Array<{ options: CommerceTaxonomyNode[]; selected: string }> = [];
  for (let depth = 0; ; depth++) {
    const parentId = depth === 0 ? null : cascadePath[depth - 1]?.id;
    if (depth > 0 && parentId === undefined) break;
    const options = commerceCategoryChildren(parentId ?? null);
    if (options.length === 0) break;
    levels.push({ options, selected: cascadePath[depth]?.id ?? '' });
    if (!cascadePath[depth]) break;
  }

  const deepestSelection = cascadePath.at(-1);
  const hasNarrowerOptions =
    deepestSelection !== undefined &&
    !resolved?.node.legacy &&
    commerceCategoryChildren(deepestSelection.id).length > 0;

  return (
    <Container className="gap-2">
      <Label htmlFor="marketplace-category-level-0" className={FORM_LABEL_CLASSES}>
        Category
      </Label>
      {isLegacyOrUnknown && (
        <div className="flex flex-wrap items-center gap-2">
          <Typography as="span" className="text-sm text-muted-foreground">
            Published as
          </Typography>
          <Badge variant="outline" data-cy="marketplace-category-published-as">
            {commerceCategoryPathLabels(value).join(' › ')}
          </Badge>
        </div>
      )}
      <div className="flex flex-col gap-2">
        {levels.map((level, depth) => (
          <Select
            key={`${depth}:${level.selected}`}
            value={level.selected}
            onValueChange={onChange}
            disabled={disabled}
          >
            <SelectTrigger
              id={`marketplace-category-level-${depth}`}
              className="h-11 w-full rounded-md border px-3"
              aria-label={depth === 0 ? 'Category' : `Category level ${depth + 1}`}
              aria-invalid={!!error}
            >
              <SelectValue placeholder={depth === 0 ? 'Choose a category' : 'Narrow it down (optional)'} />
            </SelectTrigger>
            <SelectContent>
              {level.options.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ))}
      </div>
      {hasNarrowerOptions && (
        <Typography as="p" className="text-sm text-muted-foreground">
          You can keep narrowing the category — specific categories are easier for buyers to find.
        </Typography>
      )}
      {error && (
        <Typography as="p" role="alert" className="text-sm text-destructive">
          {error}
        </Typography>
      )}
    </Container>
  );
}
