import brandsJson from './brands.v2.json';
import sizeChartsJson from './size-charts.v2.json';
import taxonomyTreeJson from './taxonomy-tree.v2.json';
import vocabulariesJson from './vocabularies.v2.json';

/**
 * Marketplace taxonomy v2: the category tree, per-category attribute
 * expectations, and the controlled vocabularies behind them.
 *
 * The assets are generated from real marketplace-industry data (a Depop
 * bulk-listing template) by `scripts/generate-marketplace-taxonomy.mjs` —
 * see docs/ecommerce/taxonomy.md for provenance and design rationale.
 *
 * VERSIONING: listing records carry `taxonomyVersion`; the tree and the
 * attribute sets are CLIENT config keyed by that number, so the protocol
 * record never churns per category. Version 2 is a strict superset of
 * version 1: every v1 category id (the four flat top levels plus the leaf
 * ids the sandbox catalog published) resolves in the v2 tree — v1 leaf ids
 * that no longer have a canonical place are kept as `legacy` nodes, which
 * resolve for display and filtering but are not offered by the studio
 * picker.
 */

export interface CommerceTaxonomyNode {
  id: string;
  label: string;
  /** Size chart name for fashion leaves that have one (see sizeCharts). */
  sizeChart?: string;
  /** Taxonomy v1 id kept resolvable; hidden from the studio picker. */
  legacy?: boolean;
  children?: CommerceTaxonomyNode[];
}

export interface CommerceVocabularyEntry {
  label: string;
  value: string;
}

export const COMMERCE_TAXONOMY_TREE = taxonomyTreeJson as CommerceTaxonomyNode[];
export const COMMERCE_SIZE_CHARTS = sizeChartsJson as Record<string, string[]>;
export const COMMERCE_VOCABULARIES = vocabulariesJson as {
  colors: CommerceVocabularyEntry[];
  sources: CommerceVocabularyEntry[];
  ages: CommerceVocabularyEntry[];
  styles: CommerceVocabularyEntry[];
};
export const COMMERCE_BRAND_SUGGESTIONS = brandsJson as CommerceVocabularyEntry[];

/** Mirrors the spec bounds for the listing `attributes` container. */
export const COMMERCE_LISTING_MAX_ATTRIBUTES = 20;
export const COMMERCE_ATTRIBUTE_KEY_MAX_CHARS = 40;
export const COMMERCE_ATTRIBUTE_VALUE_MAX_CHARS = 80;
export const COMMERCE_ATTRIBUTE_MAX_VALUES_PER_KEY = 10;
export const COMMERCE_ATTRIBUTE_KEY_PATTERN = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

export interface CommerceCategoryResolution {
  node: CommerceTaxonomyNode;
  /** Ancestors from top level down to the node itself. */
  path: CommerceTaxonomyNode[];
}

interface CategoryIndexEntry {
  node: CommerceTaxonomyNode;
  path: CommerceTaxonomyNode[];
}

const categoryIndex = new Map<string, CategoryIndexEntry>();
(function indexNodes(nodes: CommerceTaxonomyNode[], ancestors: CommerceTaxonomyNode[]): void {
  for (const node of nodes) {
    const path = [...ancestors, node];
    categoryIndex.set(node.id, { node, path });
    if (node.children) indexNodes(node.children, path);
  }
})(COMMERCE_TAXONOMY_TREE, []);

/** Resolves any known category id (current or legacy) to its node and path. */
export function resolveCommerceCategory(categoryId: string): CommerceCategoryResolution | null {
  return categoryIndex.get(categoryId) ?? null;
}

/**
 * Display label for a category id. Unknown ids (records published by other
 * clients against a taxonomy this build does not know) render as a
 * prettified form of the id itself rather than being hidden or guessed.
 */
export function commerceCategoryLabel(categoryId: string): string {
  const resolved = resolveCommerceCategory(categoryId);
  return resolved ? resolved.node.label : prettifyIdentifier(categoryId);
}

/** Breadcrumb labels for a category id, e.g. ["Fashion", "Men", "Footwear", "Boots"]. */
export function commerceCategoryPathLabels(categoryId: string): string[] {
  const resolved = resolveCommerceCategory(categoryId);
  return resolved ? resolved.path.map(({ label }) => label) : [prettifyIdentifier(categoryId)];
}

/**
 * The studio/browse children of a node (or the top level for `null`),
 * excluding legacy nodes — those resolve but are never offered.
 */
export function commerceCategoryChildren(categoryId: string | null): CommerceTaxonomyNode[] {
  const nodes =
    categoryId === null ? COMMERCE_TAXONOMY_TREE : (resolveCommerceCategory(categoryId)?.node.children ?? []);
  return nodes.filter((node) => !node.legacy);
}

export function isCommerceCategoryLeaf(categoryId: string): boolean {
  const resolved = resolveCommerceCategory(categoryId);
  return resolved !== null && commerceCategoryChildren(categoryId).length === 0;
}

// ---------------------------------------------------------------------------
// Category-dependent attributes ("item specifics")
// ---------------------------------------------------------------------------

export type CommerceAttributeInput = 'select' | 'multi-select' | 'text' | 'brand';

export interface CommerceAttributeField {
  key: string;
  label: string;
  input: CommerceAttributeInput;
  /** Present for select/multi-select inputs. */
  options?: CommerceVocabularyEntry[];
  /** Present for multi-select inputs. */
  maxValues?: number;
  required: boolean;
}

const ATTRIBUTE_LABELS: Record<string, string> = {
  size: 'Size',
  brand: 'Brand',
  color: 'Color',
  source: 'Source',
  age: 'Age / era',
  style: 'Style',
  model: 'Model',
  medium: 'Medium',
  author: 'Author',
  format: 'Format',
  material: 'Material',
};

type AttributeKey = keyof typeof ATTRIBUTE_LABELS;

/**
 * Which attributes each top-level category expects, applied to all of its
 * descendants. Fashion is grounded in the Depop template (size charts,
 * brand, up to 2 colors, source, age/era, up to 3 styles — the template
 * allows Color 1/2, Source 1/2, Age, Style 1/2/3 per listing); the rest are
 * editorial but reuse the same controlled vocabularies where they apply.
 */
const ATTRIBUTE_SETS: Record<string, AttributeKey[]> = {
  fashion: ['size', 'brand', 'color', 'source', 'age', 'style'],
  'jewelry-watches': ['brand', 'material', 'color', 'source', 'age', 'style'],
  electronics: ['brand', 'model', 'color'],
  home: ['brand', 'material', 'color', 'source', 'age'],
  art: ['medium', 'age', 'style'],
  collectibles: ['brand', 'age', 'source'],
  'books-media': ['author', 'format', 'age'],
  music: ['brand', 'format', 'age'],
  sports: ['brand', 'color'],
  beauty: ['brand', 'source'],
  'toys-games': ['brand', 'age', 'color'],
  other: ['brand', 'color'],
};

/**
 * The 1–2 attributes a catalog card may surface per top-level category,
 * in priority order.
 */
const CARD_ATTRIBUTE_KEYS: Record<string, AttributeKey[]> = {
  fashion: ['size', 'brand'],
  'jewelry-watches': ['brand', 'material'],
  electronics: ['brand', 'model'],
  home: ['brand'],
  art: ['medium'],
  collectibles: ['age'],
  'books-media': ['author'],
  music: ['format'],
  sports: ['brand'],
  beauty: ['brand'],
  'toys-games': ['brand'],
  other: ['brand'],
};

function buildAttributeField(key: AttributeKey, node: CommerceTaxonomyNode | null): CommerceAttributeField | null {
  const label = ATTRIBUTE_LABELS[key];
  switch (key) {
    case 'size': {
      // Size only appears where the leaf has a chart (per the template,
      // e.g. fashion accessories and costume have none) — and is then
      // required, mirroring marketplace expectations for sized apparel.
      const chart = node?.sizeChart ? COMMERCE_SIZE_CHARTS[node.sizeChart] : undefined;
      if (!chart) return null;
      return {
        key,
        label,
        input: 'select',
        options: chart.map((size) => ({ label: size, value: size })),
        required: true,
      };
    }
    case 'brand':
      return { key, label, input: 'brand', required: false };
    case 'color':
      return {
        key,
        label,
        input: 'multi-select',
        options: COMMERCE_VOCABULARIES.colors,
        maxValues: 2,
        required: false,
      };
    case 'source':
      return { key, label, input: 'select', options: COMMERCE_VOCABULARIES.sources, required: false };
    case 'age':
      return { key, label, input: 'select', options: COMMERCE_VOCABULARIES.ages, required: false };
    case 'style':
      return {
        key,
        label,
        input: 'multi-select',
        options: COMMERCE_VOCABULARIES.styles,
        maxValues: 3,
        required: false,
      };
    default:
      return { key, label, input: 'text', required: false };
  }
}

/**
 * The attribute fields the studio shows for a category, derived from the
 * category's top level (unknown ids get no structured fields).
 */
export function commerceAttributeFieldsFor(categoryId: string): CommerceAttributeField[] {
  const resolved = resolveCommerceCategory(categoryId);
  if (!resolved) return [];
  const topLevelId = resolved.path[0].id;
  const keys = ATTRIBUTE_SETS[topLevelId] ?? [];
  return keys
    .map((key) => buildAttributeField(key, resolved.node))
    .filter((field): field is CommerceAttributeField => field !== null);
}

/**
 * The raw attribute keys of a category's set (by top level), independent of
 * whether each field materializes on the given node — e.g. `size` is in the
 * fashion set even though it only becomes a form field on sized leaves.
 * Facets use this: filtering at "Fashion" must offer sizes found in items.
 */
export function commerceAttributeSetKeys(categoryId: string): string[] {
  const resolved = resolveCommerceCategory(categoryId);
  if (!resolved) return [];
  return ATTRIBUTE_SETS[resolved.path[0].id] ?? [];
}

/** Card-surface attribute keys for a category (priority order, max 2). */
export function commerceCardAttributeKeys(categoryId: string): string[] {
  const resolved = resolveCommerceCategory(categoryId);
  if (!resolved) return [];
  return CARD_ATTRIBUTE_KEYS[resolved.path[0].id] ?? [];
}

/** Display label for an attribute key; unknown keys are prettified, not dropped. */
export function commerceAttributeLabel(key: string): string {
  return ATTRIBUTE_LABELS[key] ?? prettifyIdentifier(key);
}

/**
 * Display label for one attribute value: controlled-vocabulary slugs map to
 * their labels; anything else (free text, foreign vocabularies) renders
 * verbatim.
 */
export function commerceAttributeValueLabel(key: string, value: string): string {
  const vocabulary =
    key === 'color'
      ? COMMERCE_VOCABULARIES.colors
      : key === 'source'
        ? COMMERCE_VOCABULARIES.sources
        : key === 'age'
          ? COMMERCE_VOCABULARIES.ages
          : key === 'style'
            ? COMMERCE_VOCABULARIES.styles
            : null;
  return vocabulary?.find((entry) => entry.value === value)?.label ?? value;
}

function prettifyIdentifier(identifier: string): string {
  const text = identifier.replaceAll(/[-_]+/g, ' ').trim();
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : identifier;
}
