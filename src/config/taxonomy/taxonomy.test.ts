import { describe, expect, it } from 'vitest';
import {
  COMMERCE_ATTRIBUTE_KEY_PATTERN,
  COMMERCE_ATTRIBUTE_VALUE_MAX_CHARS,
  COMMERCE_BRAND_SUGGESTIONS,
  COMMERCE_SIZE_CHARTS,
  COMMERCE_TAXONOMY_TREE,
  COMMERCE_VOCABULARIES,
  commerceAttributeFieldsFor,
  commerceAttributeLabel,
  commerceAttributeValueLabel,
  commerceCardAttributeKeys,
  commerceCategoryChildren,
  commerceCategoryLabel,
  commerceCategoryPathLabels,
  type CommerceTaxonomyNode,
  isCommerceCategoryLeaf,
  resolveCommerceCategory,
} from './taxonomy';

function allNodes(): Array<{ node: CommerceTaxonomyNode; ancestors: string[] }> {
  const collected: Array<{ node: CommerceTaxonomyNode; ancestors: string[] }> = [];
  const walk = (nodes: CommerceTaxonomyNode[], ancestors: string[]) => {
    for (const node of nodes) {
      collected.push({ node, ancestors });
      if (node.children) walk(node.children, [...ancestors, node.id]);
    }
  };
  walk(COMMERCE_TAXONOMY_TREE, []);
  return collected;
}

/** Every category id published under taxonomy v1 (config + sandbox catalog). */
const TAXONOMY_V1_IDS = [
  'fashion',
  'electronics',
  'home',
  'collectibles',
  'fashion-shoes-boots',
  'fashion-shoes-sneakers',
  'fashion-jackets',
  'fashion-jewelry-rings',
  'electronics-cameras-film',
  'electronics-computers-keyboards',
  'home-decor-ceramics',
  'collectibles-music-vinyl',
];

describe('taxonomy v2 config integrity', () => {
  it('has 12 top-level categories and a multi-level tree', () => {
    expect(COMMERCE_TAXONOMY_TREE).toHaveLength(12);
    const nodes = allNodes();
    expect(nodes.length).toBeGreaterThan(400);
    const maxDepth = Math.max(...nodes.map(({ ancestors }) => ancestors.length + 1));
    expect(maxDepth).toBe(4); // fashion > gender > subcategory > leaf
  });

  it('uses unique kebab-case ids prefixed by their ancestors, and prefix-safe globally', () => {
    const nodes = allNodes();
    const ids = nodes.map(({ node }) => node.id);
    expect(new Set(ids).size).toBe(ids.length);

    const ancestryById = new Map(nodes.map(({ node, ancestors }) => [node.id, ancestors]));
    for (const { node, ancestors } of nodes) {
      expect(node.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(node.id.length).toBeLessThanOrEqual(120);
      expect(node.label.length).toBeGreaterThan(0);
      for (const ancestor of ancestors) {
        expect(node.id.startsWith(`${ancestor}-`)).toBe(true);
      }
    }
    // The catalog filter matches by `${id}-` prefix, so an id may only be a
    // dash-prefix of its own descendants.
    for (const id of ids) {
      for (const other of ids) {
        if (other === id || !other.startsWith(`${id}-`)) continue;
        expect(ancestryById.get(other)).toContain(id);
      }
    }
  });

  it('resolves every taxonomy v1 category id (nothing published breaks)', () => {
    for (const id of TAXONOMY_V1_IDS) {
      const resolved = resolveCommerceCategory(id);
      expect(resolved, `v1 id '${id}' must resolve`).not.toBeNull();
      expect(commerceCategoryLabel(id)).not.toBe('');
    }
  });

  it('keeps legacy nodes resolvable but out of the picker', () => {
    const legacyIds = allNodes()
      .filter(({ node }) => node.legacy)
      .map(({ node }) => node.id);
    expect(legacyIds).toEqual(
      expect.arrayContaining(['fashion-shoes-boots', 'fashion-jackets', 'collectibles-music-vinyl']),
    );
    for (const id of legacyIds) {
      const resolved = resolveCommerceCategory(id);
      expect(resolved).not.toBeNull();
      const parentId = resolved!.path.at(-2)?.id ?? null;
      expect(commerceCategoryChildren(parentId).some((child) => child.id === id)).toBe(false);
    }
  });

  it('resolves every referenced size chart, with in-bounds values', () => {
    for (const { node } of allNodes()) {
      if (!node.sizeChart) continue;
      const chart = COMMERCE_SIZE_CHARTS[node.sizeChart];
      expect(chart, `chart '${node.sizeChart}' for '${node.id}'`).toBeDefined();
      expect(chart.length).toBeGreaterThan(0);
      for (const size of chart) {
        expect(size.length).toBeGreaterThan(0);
        expect(size.length).toBeLessThanOrEqual(COMMERCE_ATTRIBUTE_VALUE_MAX_CHARS);
      }
    }
    // The Depop template sizes 216 fashion leaves across 10 charts.
    expect(Object.keys(COMMERCE_SIZE_CHARTS)).toHaveLength(10);
    expect(allNodes().filter(({ node }) => node.sizeChart).length).toBe(216);
  });

  it('gives every top-level category an attribute set with vocabulary-backed options', () => {
    for (const top of COMMERCE_TAXONOMY_TREE) {
      const probeLeaf = firstLeafUnder(top);
      const fields = commerceAttributeFieldsFor(probeLeaf.id);
      expect(fields.length, `attribute set for '${top.id}'`).toBeGreaterThan(0);
      for (const field of fields) {
        expect(field.key).toMatch(COMMERCE_ATTRIBUTE_KEY_PATTERN);
        expect(commerceAttributeLabel(field.key)).not.toBe(field.key);
        if (field.input === 'select' || field.input === 'multi-select') {
          expect(field.options, `options for '${field.key}' in '${top.id}'`).toBeDefined();
          expect(field.options!.length).toBeGreaterThan(0);
          for (const option of field.options!) {
            expect(option.value.length).toBeLessThanOrEqual(COMMERCE_ATTRIBUTE_VALUE_MAX_CHARS);
          }
        }
      }
      // Card attributes must be a subset of the category's attribute set.
      const fieldKeys = new Set(fields.map(({ key }) => key));
      const cardKeys = commerceCardAttributeKeys(probeLeaf.id);
      expect(cardKeys.length).toBeGreaterThan(0);
      expect(cardKeys.length).toBeLessThanOrEqual(2);
      for (const key of cardKeys) {
        // Size is set-listed for fashion but only materializes on sized
        // leaves; every other card key must materialize on the probe leaf.
        if (key === 'size') continue;
        expect(fieldKeys.has(key), `card key '${key}' for '${top.id}'`).toBe(true);
      }
    }
  });

  it('requires size exactly on fashion leaves that have a chart', () => {
    const sized = resolveCommerceCategory('fashion-men-footwear-boots');
    expect(sized?.node.sizeChart).toBe('mens-footwear');
    const sizedFields = commerceAttributeFieldsFor('fashion-men-footwear-boots');
    const sizeField = sizedFields.find(({ key }) => key === 'size');
    expect(sizeField).toMatchObject({ required: true, input: 'select' });
    expect(sizeField!.options!.map(({ value }) => value)).toContain('US 9');

    // Chartless fashion leaf: no size field at all.
    expect(commerceAttributeFieldsFor('fashion-men-accessories-belt').some(({ key }) => key === 'size')).toBe(false);
    // Non-fashion categories never get a size field.
    expect(commerceAttributeFieldsFor('electronics-cameras-film').some(({ key }) => key === 'size')).toBe(false);
  });

  it('carries the Depop vocabularies wholesale', () => {
    expect(COMMERCE_VOCABULARIES.colors).toHaveLength(19);
    expect(COMMERCE_VOCABULARIES.sources).toHaveLength(8);
    expect(COMMERCE_VOCABULARIES.ages).toHaveLength(8);
    expect(COMMERCE_VOCABULARIES.styles).toHaveLength(32);
    expect(commerceAttributeValueLabel('age', 'y2k')).toBe('00s');
    expect(commerceAttributeValueLabel('color', 'burgundy')).toBe('Burgundy');
    // Unknown values render verbatim rather than being dropped or guessed.
    expect(commerceAttributeValueLabel('color', 'taupe')).toBe('taupe');
  });

  it('ships a curated brand shortlist, not the full industry list', () => {
    expect(COMMERCE_BRAND_SUGGESTIONS.length).toBeGreaterThanOrEqual(250);
    expect(COMMERCE_BRAND_SUGGESTIONS.length).toBeLessThanOrEqual(500);
    const labels = COMMERCE_BRAND_SUGGESTIONS.map(({ label }) => label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const { label, value } of COMMERCE_BRAND_SUGGESTIONS) {
      expect(label.trim()).toBe(label);
      expect(label.length).toBeLessThanOrEqual(COMMERCE_ATTRIBUTE_VALUE_MAX_CHARS);
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it('prettifies unknown category ids and attribute keys instead of dropping them', () => {
    expect(resolveCommerceCategory('from-another-taxonomy')).toBeNull();
    expect(commerceCategoryLabel('from-another-taxonomy')).toBe('From another taxonomy');
    expect(commerceCategoryPathLabels('from-another-taxonomy')).toEqual(['From another taxonomy']);
    expect(commerceAttributeLabel('graded-by')).toBe('Graded by');
    expect(commerceAttributeFieldsFor('from-another-taxonomy')).toEqual([]);
  });

  it('exposes leaf checks the studio picker relies on', () => {
    expect(isCommerceCategoryLeaf('fashion-men-footwear-boots')).toBe(true);
    expect(isCommerceCategoryLeaf('fashion-men')).toBe(false);
    expect(isCommerceCategoryLeaf('fashion')).toBe(false);
    expect(isCommerceCategoryLeaf('not-a-category')).toBe(false);
  });
});

function firstLeafUnder(node: CommerceTaxonomyNode): CommerceTaxonomyNode {
  let current = node;
  while (current.children) {
    const nonLegacy = current.children.find((child) => !child.legacy);
    if (!nonLegacy) break;
    current = nonLegacy;
  }
  return current;
}
