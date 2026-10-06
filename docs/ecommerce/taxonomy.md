# Marketplace taxonomy and item specifics

Taxonomy v2 replaces the flat four-category picker with a real category tree
and category-dependent listing attributes ("item specifics"), grounded in
real marketplace-industry data.

## Provenance

The v2 config assets under `src/config/taxonomy/` are **generated** by
`scripts/generate-marketplace-taxonomy.mjs` from data extracted from a Depop
bulk-listing template (two JSON files, not committed to this repo):

- `depop-dropdowns.json` — 319 categories as a 3-level tree
  (`Men >> Footwear >> Boots` plus slugs), 14,038 brands, 5 conditions,
  19 colors, 8 sources, 8 age/era values, 32 styles, countries.
- `depop-sizes.json` — 216 fashion categories mapped to 13 size lists
  (deduplicated to 10 distinct charts by content).

Depop's template allows Color 1/2, Source 1/2, Age, and Style 1/2/3 per
listing — that is where the "up to 2 colors / up to 3 styles" limits come
from. Rerun the generator with the two source files as arguments to
regenerate; it fails loudly on any invariant violation (see below) instead
of writing partial output.

## Design

### Spec vs config split

Listing records already carry `taxonomyVersion`. The split we shipped:

- **The spec** (pubky-app-specs fork, `0.6.2-marketplace.4`) gains exactly
  one stable, generic, bounded container:
  `attributes?: Record<string, string | string[]>` — at most 20 keys; keys
  are lowercase alphanumeric identifiers with single `-`/`_` separators,
  1–40 chars; values are trimmed strings of 1–80 chars; list values hold
  1–10 unique entries. `taxonomyVersion` changed from "must be 1" to a
  bounded integer (1–1,000,000).
- **The taxonomy itself** — the category tree, which attributes each
  category expects, and the allowed values — is versioned **client config**
  keyed by `taxonomyVersion` (`src/config/taxonomy/`).

This keeps protocol records self-describing without spec churn per
category: adding a category or attribute set is a client config change, not
a protocol release. The client Zod schema (`marketplace-records.ts`) mirrors
the same bounds, so records validate identically on both sides of the wasm
boundary (pinned by `commerce.specs.test.ts`).

### Category tree (v2)

12 top-level categories, up to 4 levels deep, 422 nodes:

- **Fashion** — the Depop tree imported wholesale: Men / Women / Kids, each
  with their Depop subcategories and leaves (267 leaves). Fashion is the
  only branch with 4 levels (`fashion > gender > subcategory > leaf`).
- **Electronics, Home & Garden, Art, Collectibles, Books & Media,
  Music & Instruments, Sports & Outdoors, Beauty, Toys & Games,
  Jewelry & Watches, Everything else** — generalized from Depop's
  "Everything else" tree where it has the data (art, beauty, sports, toys,
  home, party supplies, books, music, tech accessories, face masks,
  umbrellas) and editorial where it does not (electronics subtree,
  collectibles subtree, jewelry & watches). The generator marks
  Depop-derived nodes with `[Depop]` comments. Depop's `Art >> Collectibles`
  leaf was deliberately dropped in favor of the dedicated Collectibles top
  level; Depop's `Toys >> Trading cards` moved to Collectibles.

**Id scheme**: full-path kebab ids where a child id is
`{parent-id}-{slug}` (e.g. `fashion-men-footwear-boots`). This is what makes
the existing prefix-based category filter
(`categoryId.startsWith(`${filter}-`)`) match whole subtrees. Enforced
invariants (generator **and** `taxonomy.test.ts`):

- ids are kebab-case, ≤120 chars (the spec's `categoryId` rules), unique;
- every id is prefixed by all of its ancestors;
- **prefix safety**: an id may only be a `-`-prefix of its own descendants,
  so prefix filtering can never match an unrelated category.

### Compatibility with published records (migration story)

Nothing published breaks and nothing is rewritten:

- The four v1 top-level ids (`fashion`, `electronics`, `home`,
  `collectibles`) are real v2 top-level nodes (`home` relabeled
  "Home & Garden").
- v1 leaf ids that have a canonical place in v2 are real nodes
  (`electronics-cameras-film`, `electronics-computers-keyboards`,
  `home-decor-ceramics`).
- v1 leaf ids that don't (`fashion-shoes-boots`, `fashion-shoes-sneakers`,
  `fashion-jackets`, `fashion-jewelry-rings`, `collectibles-music-vinyl`)
  are kept as **legacy nodes**: they resolve for display, filtering, and
  icons, but the studio picker and browse chips never offer them.
- v1 records validate as-is: `taxonomyVersion: 1` is in range and absent
  `attributes` is valid. New listings publish `taxonomyVersion: 2`.
- Unknown category ids (other clients, future taxonomies) display as a
  prettified form of the id itself — never hidden, never guessed.

### Category-dependent attributes

Attribute sets are assigned per **top-level** category and apply to all
descendants. Vocabulary-backed fields use the Depop vocabularies wholesale
(colors 19, sources 8, ages 8, styles 32); size options come from the
leaf's size chart.

| Top level           | Attributes (required in bold)                                                             |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Fashion             | **size** (chart select, only on sized leaves), brand, color ×2, source, age/era, style ×3 |
| Jewelry & Watches   | brand, material, color ×2, source, age/era, style ×3                                      |
| Electronics         | brand, model, color ×2                                                                    |
| Home & Garden       | brand, material, color ×2, source, age/era                                                |
| Art                 | medium, age/era, style ×3                                                                 |
| Collectibles        | brand, age/era, source                                                                    |
| Books & Media       | author, format, age/era                                                                   |
| Music & Instruments | brand, format, age/era                                                                    |
| Sports & Outdoors   | brand, color ×2                                                                           |
| Beauty              | brand, source                                                                             |
| Toys & Games        | brand, age/era, color ×2                                                                  |
| Everything else     | brand, color ×2                                                                           |

**Size** appears only on fashion leaves that have a size chart in the Depop
data (216 of 267) and is then required; chartless leaves (accessories,
costume) get no size field, per the source data. The 10 charts:
`mens-clothing`, `mens-bottoms`, `mens-footwear`, `womens-clothing`,
`womens-bottoms`, `womens-intimates`, `womens-outerwear`, `womens-footwear`,
`kids-clothing`, `kids-footwear`.

**Stored values**: vocabulary-backed attributes store the vocabulary slug
(`grey`, `y2k`, `reworked`); display maps slugs to labels and renders
unknown values verbatim. Brand and the free-text attributes (model, medium,
author, format, material) store the display text the seller entered.

### Brand list curation

Shipping all 14k brands as a bundle was rejected (hundreds of KB for a
typeahead). Instead, `brands.v2.json` is a curated shortlist of **328**
widely recognizable brands across this taxonomy's top levels (sportswear,
streetwear, high street, designer, watches/jewelry, electronics, cameras,
gaming, music, home, toys, outdoors, beauty). Curation is editorial, but
membership is mechanical: the generator fails unless every curated label
exists verbatim in the Depop brand vocabulary, so labels and slugs match an
established marketplace vocabulary. The studio offers the shortlist as
native datalist typeahead suggestions; **free entry is always allowed** —
the shortlist is a convenience, not a gate.

### Studio behavior

- The category picker is a cascading select over the tree; picking at any
  level stores that node's id immediately, and deeper selects appear while
  children remain. A hint (not a validation error) nudges toward leaves.
- Once a category is chosen, its attribute fields appear
  (`MarketplaceListingAttributeFields`): chart-select size, brand typeahead,
  color/style toggle chips, source/age selects, free-text fields. Only
  filled-in fields publish.
- **Editing preserves attributes**: values the form can express (known keys,
  in-vocabulary values, expected shapes) hydrate into the form; everything
  else — foreign keys, foreign vocabulary values, unexpected shapes — is
  carried through the save verbatim (`partitionListingAttributes`). Records
  hydrated with legacy/unknown categories keep their published id until the
  seller picks something else, shown as a "Published as" breadcrumb.
- Drafts autosave the attribute fields like every other field.

### Filters and browse

- Category navigation is a drill-down chip row: breadcrumb of the current
  path (clickable to jump back up) plus the current node's children.
  Filtering by any node includes its whole subtree via prefix matching.
- Attribute facets (size / brand / color, where the current category's set
  defines them) render as value chips with counts, computed client-side
  over the cached catalog. **Honest scoping**: Nexus index projections do
  not carry attributes, so items known only from the index report
  attributes as _unknown_ (`null`) — they are excluded while an attribute
  filter is active, and the UI says the filters cover listings whose full
  details are cached on this device. Changing the category clears the
  attribute filters (they are category-scoped).
- **Follow-up (out of scope)**: Nexus-side attribute indexing, so facets
  and attribute filtering can cover the whole index rather than cached
  records.

### Display

- The listing detail page shows an "Item specifics" table: the category
  breadcrumb plus every attribute on the record. Known keys get configured
  labels and vocabulary display values; unknown keys render as a prettified
  label with the raw value — attributes are never dropped.
- Catalog cards surface at most the 1–2 highest-value attributes per
  category (size then brand for fashion, brand then model for electronics,
  medium for art, …) — only for record-backed cards; index-entry cards show
  nothing rather than a guess.

## Versioning and evolution

- `COMMERCE_TAXONOMY_VERSION` (currently 2) is what new listings publish.
- Additive changes to v2 (new categories, new attribute keys, longer brand
  shortlist) need no version bump — old records stay valid because the
  spec's attributes container is shape-bounded, not schema-bound.
- Renaming/removing category ids requires a version bump plus keeping the
  old ids as legacy nodes, exactly as v1 ids are kept today. The
  config-integrity test (`taxonomy.test.ts`) pins every previously
  published id to keep resolving.

## Files

- `scripts/generate-marketplace-taxonomy.mjs` — generator (provenance above)
- `src/config/taxonomy/taxonomy-tree.v2.json` — the tree (422 nodes)
- `src/config/taxonomy/size-charts.v2.json` — 10 size charts
- `src/config/taxonomy/vocabularies.v2.json` — colors/sources/ages/styles
- `src/config/taxonomy/brands.v2.json` — curated brand shortlist (328)
- `src/config/taxonomy/taxonomy.ts` — resolution, attribute sets, labels
- `src/config/taxonomy/taxonomy.test.ts` — config-integrity tests
