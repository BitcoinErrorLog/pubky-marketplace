#!/usr/bin/env node
/**
 * Generates the marketplace taxonomy v2 config assets from the Depop
 * bulk-listing template data (see docs/ecommerce/taxonomy.md for provenance
 * and the design rationale).
 *
 * Usage:
 *   node scripts/generate-marketplace-taxonomy.mjs <depop-dropdowns.json> <depop-sizes.json>
 *
 * Inputs (NOT in this repo — extracted from Depop's bulk-listing template):
 *   - depop-dropdowns.json: { A: categories (319 "Top >> Sub >> Leaf (slugs)"
 *     lines), B: brands ("Label (slug)"), D: colors, E: sources, F: age/era,
 *     G: styles }
 *   - depop-sizes.json: { A: fashion category lines, B: size-list id per row,
 *     D..P: size lists whose first element is the list id }
 *
 * Outputs (committed, deterministic):
 *   - src/config/taxonomy/taxonomy-tree.v2.json
 *   - src/config/taxonomy/size-charts.v2.json
 *   - src/config/taxonomy/vocabularies.v2.json
 *   - src/config/taxonomy/brands.v2.json
 *
 * The Depop fashion tree (Men/Women/Kids) is imported wholesale under the
 * `fashion` top level. The remaining top levels generalize Depop's
 * "Everything else" into a general-marketplace tree; nodes marked with a
 * `[Depop]` comment below are lifted from that data, the rest are editorial.
 * The script enforces the invariants the client config relies on:
 * kebab-case ids, globally prefix-safe ids (an id may only be a `-` prefix
 * of its own descendants), every size chart referenced exists, and every
 * curated brand exists in the Depop brand vocabulary.
 */

import { mkdirSync,readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dropdownsPath, sizesPath] = process.argv.slice(2);
if (!dropdownsPath || !sizesPath) {
  console.error('Usage: node scripts/generate-marketplace-taxonomy.mjs <depop-dropdowns.json> <depop-sizes.json>');
  process.exit(1);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'src', 'config', 'taxonomy');

const dropdowns = JSON.parse(readFileSync(dropdownsPath, 'utf8'));
const sizes = JSON.parse(readFileSync(sizesPath, 'utf8'));

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(message) {
  console.error(`generate-marketplace-taxonomy: ${message}`);
  process.exit(1);
}

function unescapeHtml(value) {
  return value
    .replaceAll(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

/** Parses one "Label (slug)" vocabulary line. */
function parseLabeled(line) {
  const match = /^(.*) \(([^()]*)\)$/.exec(line);
  if (!match) fail(`cannot parse vocabulary line: ${line}`);
  return { label: unescapeHtml(match[1]), value: match[2] };
}

/** Parses one "Top >> Sub >> Leaf (topSlug, subSlug, leafSlug)" category line. */
function parseCategoryLine(line) {
  const match = /^(.*) \(([^()]*)\)$/.exec(line);
  if (!match) fail(`cannot parse category line: ${line}`);
  const labels = match[1].split(' >> ').map((part) => unescapeHtml(part.trim()));
  const slugs = match[2].split(',').map((part) => part.trim());
  if (labels.length !== 3 || slugs.length !== 3) fail(`expected 3 levels: ${line}`);
  for (const slug of slugs) {
    if (!KEBAB.test(slug)) fail(`non-kebab slug '${slug}' in: ${line}`);
  }
  return { labels, slugs };
}

// ---------------------------------------------------------------------------
// Fashion tree from the Depop category data
// ---------------------------------------------------------------------------

const GENDER_BY_TOP = new Map([
  ['Men', { id: 'fashion-men', label: 'Men' }],
  ['Women', { id: 'fashion-women', label: 'Women' }],
  ['Kids', { id: 'fashion-kids', label: 'Kids' }],
]);

const fashionChildren = new Map(); // gender id -> Map(subcat id -> node)
for (const { id } of GENDER_BY_TOP.values()) fashionChildren.set(id, new Map());
const leafIdByCategoryLine = new Map(); // normalized "Top >> Sub >> Leaf" -> leaf node id

for (const line of dropdowns.A) {
  const { labels, slugs } = parseCategoryLine(line);
  const [top, sub, leaf] = labels;
  if (!GENDER_BY_TOP.has(top)) continue; // "Everything else" handled below
  const gender = GENDER_BY_TOP.get(top);
  const subId = `${gender.id}-${slugs[1]}`;
  const subcats = fashionChildren.get(gender.id);
  if (!subcats.has(subId)) subcats.set(subId, { id: subId, label: sub, children: [] });
  const leafId = `${subId}-${slugs[2]}`;
  subcats.get(subId).children.push({ id: leafId, label: leaf });
  leafIdByCategoryLine.set(labels.join(' >> '), leafId);
}

// ---------------------------------------------------------------------------
// Size charts (fashion): rows in sizes.A reference a size list id in sizes.B;
// the other columns are the size lists (first element = list id). Lists with
// identical contents are merged under one descriptive chart name.
// ---------------------------------------------------------------------------

const CHART_NAME_BY_LIST_ID = new Map([
  ['77', 'mens-footwear'],
  ['46', 'womens-footwear'],
  ['103', 'kids-footwear'],
  ['100', 'kids-clothing'],
  ['60', 'mens-bottoms'],
  ['22', 'womens-bottoms'],
  ['30', 'womens-intimates'],
  ['38', 'womens-outerwear'],
  ['89', 'mens-clothing'],
  ['54', 'mens-clothing'],
  ['95', 'mens-clothing'],
  ['84', 'womens-clothing'],
  ['4', 'womens-clothing'],
]);

const sizeCharts = {};
for (const column of Object.keys(sizes)) {
  if (column === 'A' || column === 'B') continue;
  const [listId, ...values] = sizes[column];
  const chartName = CHART_NAME_BY_LIST_ID.get(listId);
  if (!chartName) fail(`size list '${listId}' has no chart name`);
  if (sizeCharts[chartName]) {
    if (JSON.stringify(sizeCharts[chartName]) !== JSON.stringify(values)) {
      fail(`size lists sharing chart name '${chartName}' differ in content`);
    }
    continue;
  }
  sizeCharts[chartName] = values;
}

const sizeChartByLeafId = new Map();
for (let row = 0; row < sizes.A.length; row++) {
  const { labels } = parseCategoryLine(sizes.A[row]);
  const leafId = leafIdByCategoryLine.get(labels.join(' >> '));
  if (!leafId) fail(`size row references unknown category: ${sizes.A[row]}`);
  const chartName = CHART_NAME_BY_LIST_ID.get(sizes.B[row]);
  if (!chartName) fail(`size row references unknown list id '${sizes.B[row]}'`);
  if (!sizeCharts[chartName]) fail(`chart '${chartName}' missing from size lists`);
  sizeChartByLeafId.set(leafId, chartName);
}

function withSizeCharts(node) {
  const chart = sizeChartByLeafId.get(node.id);
  const children = node.children?.map(withSizeCharts);
  return {
    id: node.id,
    label: node.label,
    ...(chart ? { sizeChart: chart } : {}),
    ...(children && children.length > 0 ? { children } : {}),
    ...(node.legacy ? { legacy: true } : {}),
  };
}

const fashionNode = {
  id: 'fashion',
  label: 'Fashion',
  children: [
    ...[...GENDER_BY_TOP.values()].map((gender) => ({
      id: gender.id,
      label: gender.label,
      children: [...fashionChildren.get(gender.id).values()],
    })),
    // Taxonomy v1 leaf ids published by existing listings: they resolve for
    // display/filtering but the studio picker no longer offers them.
    { id: 'fashion-shoes-boots', label: 'Boots', legacy: true },
    { id: 'fashion-shoes-sneakers', label: 'Sneakers', legacy: true },
    { id: 'fashion-jackets', label: 'Coats & jackets', legacy: true },
    { id: 'fashion-jewelry-rings', label: 'Rings', legacy: true },
  ],
};

// ---------------------------------------------------------------------------
// General (non-fashion) top levels. [Depop] marks nodes lifted from the
// template's "Everything else" tree; the rest are editorial for a general
// marketplace. Depop's "Art >> Collectibles" leaf is intentionally omitted:
// this taxonomy has a dedicated Collectibles top level.
// ---------------------------------------------------------------------------

const generalTree = [
  {
    id: 'electronics',
    label: 'Electronics',
    children: [
      { id: 'electronics-phones', label: 'Phones & accessories' },
      {
        id: 'electronics-computers',
        label: 'Computers & office',
        children: [
          { id: 'electronics-computers-laptops', label: 'Laptops' },
          { id: 'electronics-computers-desktops', label: 'Desktops' },
          { id: 'electronics-computers-keyboards', label: 'Keyboards' },
          { id: 'electronics-computers-mice-peripherals', label: 'Mice & peripherals' },
          { id: 'electronics-computers-monitors', label: 'Monitors' },
          { id: 'electronics-computers-components', label: 'Parts & components' },
        ],
      },
      { id: 'electronics-cameras-film', label: 'Cameras & film' }, // [Depop]
      {
        id: 'electronics-audio',
        label: 'Audio',
        children: [
          { id: 'electronics-audio-headphones', label: 'Headphones' },
          { id: 'electronics-audio-speakers', label: 'Speakers' },
          { id: 'electronics-audio-home-audio', label: 'Home audio & hi-fi' },
        ],
      },
      {
        id: 'electronics-video-games',
        label: 'Video games & consoles',
        children: [
          { id: 'electronics-video-games-consoles', label: 'Consoles' },
          { id: 'electronics-video-games-games', label: 'Games' },
          { id: 'electronics-video-games-accessories', label: 'Gaming accessories' },
        ],
      },
      { id: 'electronics-wearables', label: 'Wearable tech' },
      { id: 'electronics-tvs', label: 'TVs & video' },
      {
        id: 'electronics-tech-accessories',
        label: 'Tech accessories', // [Depop]
        children: [
          { id: 'electronics-tech-accessories-phone-cases', label: 'Phone cases' }, // [Depop]
          { id: 'electronics-tech-accessories-laptop-bags', label: 'Laptop bags & cases' }, // [Depop]
        ],
      },
    ],
  },
  {
    id: 'home',
    label: 'Home & Garden',
    children: [
      { id: 'home-furniture', label: 'Furniture' }, // [Depop]
      { id: 'home-dinnerware', label: 'Dinnerware & tableware' }, // [Depop]
      {
        id: 'home-decor',
        label: 'Décor & home accessories', // [Depop]
        children: [
          { id: 'home-decor-ceramics', label: 'Ceramics' },
          { id: 'home-decor-candles', label: 'Candles & holders' },
          { id: 'home-decor-wall-decor', label: 'Wall décor' },
        ],
      },
      { id: 'home-soft-furnishings', label: 'Soft furnishings & textiles' }, // [Depop]
      { id: 'home-storage', label: 'Storage & organization' }, // [Depop]
      { id: 'home-kitchen', label: 'Kitchen accessories' },
      { id: 'home-garden', label: 'Garden & outdoor' },
      { id: 'home-appliances', label: 'Small appliances' },
      {
        id: 'home-party-supplies',
        label: 'Party supplies', // [Depop]
        children: [
          { id: 'home-party-supplies-cake-decorating', label: 'Cake decorating' }, // [Depop]
          { id: 'home-party-supplies-cards-gift-wrap', label: 'Cards, invitations & gift wrap' }, // [Depop]
          { id: 'home-party-supplies-decorations', label: 'Decorations' }, // [Depop]
          { id: 'home-party-supplies-party-favors', label: 'Party favors' }, // [Depop]
          { id: 'home-party-supplies-party-hats', label: 'Party hats' }, // [Depop]
        ],
      },
    ],
  },
  {
    id: 'art',
    label: 'Art',
    children: [
      { id: 'art-drawings-illustrations', label: 'Drawings & illustrations' }, // [Depop]
      { id: 'art-mixed-media', label: 'Mixed media' }, // [Depop]
      { id: 'art-paintings', label: 'Paintings' }, // [Depop]
      { id: 'art-photography', label: 'Photography' }, // [Depop]
      { id: 'art-prints', label: 'Prints' }, // [Depop]
      { id: 'art-sculptures', label: 'Sculptures' }, // [Depop]
      { id: 'art-stickers', label: 'Stickers' }, // [Depop]
    ],
  },
  {
    id: 'collectibles',
    label: 'Collectibles',
    children: [
      { id: 'collectibles-trading-cards', label: 'Trading cards' }, // [Depop, relocated from Toys]
      { id: 'collectibles-coins-currency', label: 'Coins & currency' },
      { id: 'collectibles-stamps', label: 'Stamps' },
      { id: 'collectibles-comics', label: 'Comics' },
      { id: 'collectibles-memorabilia', label: 'Memorabilia' },
      { id: 'collectibles-figurines', label: 'Figurines' },
      { id: 'collectibles-antiques', label: 'Antiques' },
      { id: 'collectibles-pins-patches', label: 'Pins & patches' },
      // Taxonomy v1 id published by existing listings.
      { id: 'collectibles-music-vinyl', label: 'Vinyl records', legacy: true },
    ],
  },
  {
    id: 'books-media',
    label: 'Books & Media',
    children: [
      { id: 'books-media-books', label: 'Books' }, // [Depop]
      { id: 'books-media-magazines', label: 'Magazines' }, // [Depop]
      { id: 'books-media-movies-tv', label: 'Movies & TV' },
    ],
  },
  {
    id: 'music',
    label: 'Music & Instruments',
    children: [
      { id: 'music-vinyl', label: 'Vinyl records' }, // [Depop: CDs and vinyl]
      { id: 'music-cds-tapes', label: 'CDs & tapes' }, // [Depop: CDs and vinyl]
      {
        id: 'music-instruments',
        label: 'Musical instruments', // [Depop]
        children: [
          { id: 'music-instruments-guitars', label: 'Guitars & basses' },
          { id: 'music-instruments-keyboards-pianos', label: 'Keyboards & pianos' },
          { id: 'music-instruments-drums-percussion', label: 'Drums & percussion' },
          { id: 'music-instruments-other', label: 'Other instruments' },
        ],
      },
      { id: 'music-dj-equipment', label: 'DJ & studio equipment' }, // [Depop]
      { id: 'music-accessories', label: 'Music accessories' },
    ],
  },
  {
    id: 'sports',
    label: 'Sports & Outdoors',
    children: [
      { id: 'sports-ball-sports', label: 'Ball sports' }, // [Depop]
      { id: 'sports-camping-hiking', label: 'Camping & hiking' }, // [Depop]
      { id: 'sports-cycling', label: 'Cycling' }, // [Depop]
      { id: 'sports-fitness', label: 'Fitness' }, // [Depop]
      { id: 'sports-golf', label: 'Golf' }, // [Depop]
      { id: 'sports-racket-sports', label: 'Racket sports' }, // [Depop]
      { id: 'sports-skates-skateboards-scooters', label: 'Skates, skateboards & scooters' }, // [Depop]
      { id: 'sports-water-sports', label: 'Water sports' }, // [Depop]
      { id: 'sports-winter-sports', label: 'Winter sports' }, // [Depop]
    ],
  },
  {
    id: 'beauty',
    label: 'Beauty',
    children: [
      { id: 'beauty-bath-body', label: 'Bath & body' }, // [Depop]
      { id: 'beauty-fragrance', label: 'Fragrance' }, // [Depop]
      { id: 'beauty-grooming', label: 'Grooming' }, // [Depop]
      { id: 'beauty-haircare', label: 'Haircare' }, // [Depop]
      { id: 'beauty-makeup', label: 'Makeup' }, // [Depop]
      { id: 'beauty-nails', label: 'Nails' }, // [Depop]
      { id: 'beauty-skincare', label: 'Skincare' }, // [Depop]
      { id: 'beauty-tools-brushes', label: 'Tools & brushes' }, // [Depop]
    ],
  },
  {
    id: 'toys-games',
    label: 'Toys & Games',
    children: [
      { id: 'toys-games-action-figures', label: 'Action figures & playsets' }, // [Depop]
      { id: 'toys-games-building-sets', label: 'Building sets & blocks' }, // [Depop]
      { id: 'toys-games-cars-vehicles', label: 'Cars & vehicles' }, // [Depop]
      { id: 'toys-games-dolls', label: 'Dolls & accessories' }, // [Depop]
      { id: 'toys-games-learning-toys', label: 'Learning toys' }, // [Depop]
      { id: 'toys-games-puzzles', label: 'Puzzles & games' }, // [Depop]
      { id: 'toys-games-stuffed-animals', label: 'Stuffed animals' }, // [Depop]
      { id: 'toys-games-board-games', label: 'Board games' },
    ],
  },
  {
    id: 'jewelry-watches',
    label: 'Jewelry & Watches',
    children: [
      { id: 'jewelry-watches-necklaces', label: 'Necklaces' },
      { id: 'jewelry-watches-rings', label: 'Rings' },
      { id: 'jewelry-watches-earrings', label: 'Earrings' },
      { id: 'jewelry-watches-bracelets', label: 'Bracelets' },
      { id: 'jewelry-watches-brooches-pins', label: 'Brooches & pins' },
      { id: 'jewelry-watches-watches', label: 'Watches' },
    ],
  },
  {
    id: 'other',
    label: 'Everything else',
    children: [
      { id: 'other-face-masks', label: 'Face masks & coverings' }, // [Depop]
      { id: 'other-umbrellas', label: 'Umbrellas' }, // [Depop]
    ],
  },
];

const tree = [withSizeCharts(fashionNode), ...generalTree];

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

const allIds = new Map(); // id -> ancestry path string
(function collect(nodes, ancestors) {
  for (const node of nodes) {
    if (!KEBAB.test(node.id)) fail(`non-kebab node id '${node.id}'`);
    if (node.id.length > 120) fail(`node id '${node.id}' exceeds 120 chars`);
    if (allIds.has(node.id)) fail(`duplicate node id '${node.id}'`);
    for (const ancestor of ancestors) {
      if (!node.id.startsWith(`${ancestor}-`)) {
        fail(`node id '${node.id}' is not prefixed by its ancestor '${ancestor}'`);
      }
    }
    allIds.set(node.id, ancestors.join('>'));
    if (node.children) collect(node.children, [...ancestors, node.id]);
  }
})(tree, []);

// Prefix filtering safety: an id may only be a '-' prefix of its descendants.
for (const id of allIds.keys()) {
  for (const [other, otherAncestry] of allIds) {
    if (other === id || !other.startsWith(`${id}-`)) continue;
    if (!otherAncestry.split('>').includes(id)) {
      fail(`id '${other}' collides with unrelated node '${id}' under prefix filtering`);
    }
  }
}

for (const chartName of new Set(sizeChartByLeafId.values())) {
  if (!sizeCharts[chartName]) fail(`leaf references undefined size chart '${chartName}'`);
}

// ---------------------------------------------------------------------------
// Vocabularies (Depop columns D/E/F/G, wholesale)
// ---------------------------------------------------------------------------

const vocabularies = {
  colors: dropdowns.D.map(parseLabeled),
  sources: dropdowns.E.map(parseLabeled),
  ages: dropdowns.F.map(parseLabeled),
  styles: dropdowns.G.map(parseLabeled),
};

// ---------------------------------------------------------------------------
// Curated brand shortlist: recognizable brands across this taxonomy's top
// levels, restricted to labels present in the Depop brand vocabulary (14k+
// entries) so labels and slugs match an established marketplace vocabulary.
// The studio offers these as typeahead suggestions; free entry is allowed.
// ---------------------------------------------------------------------------

const CURATED_BRAND_LABELS = [
  // Sportswear, streetwear, footwear
  'Nike',
  'Jordan',
  'Adidas',
  'Puma',
  'Reebok',
  'New Balance',
  'ASICS',
  'Converse',
  'Vans',
  'Champion',
  'Fila',
  'Umbro',
  'Kappa',
  'Ellesse',
  'Under Armour',
  'Lululemon',
  'Gymshark',
  'Alo Yoga',
  'Vuori',
  'Columbia Sportswear',
  'The North Face',
  'Patagonia',
  "Arc'teryx",
  'Timberland',
  'Dr. Martens',
  'Birkenstock',
  'Crocs',
  'Clarks',
  'Salomon',
  'Merrell',
  'Hoka One One',
  'On Running',
  'Brooks',
  'Saucony',
  'Mizuno',
  'Supreme',
  'Stüssy',
  'BAPE',
  'Palace',
  'Kith',
  'HUF',
  'Obey',
  'Thrasher',
  'Santa Cruz',
  'Carhartt',
  'Carhartt WIP',
  'Dickies',
  "Levi's",
  'Wrangler',
  'Lee',
  'Diesel',
  'True Religion',
  'Evisu',
  'G-Star RAW',
  'Nudie Jeans',
  'Edwin',
  'Fear of God',
  'Essentials',
  'Off-White',
  'Y-3',
  'Yeezy',
  'Billabong',
  'Quiksilver',
  'Rip Curl',
  'Volcom',
  'Element',
  // High street
  'Zara',
  'H&M',
  'UNIQLO',
  'Gap',
  'Old Navy',
  'Banana Republic',
  'J.Crew',
  'Madewell',
  'Everlane',
  'Abercrombie & Fitch',
  'Hollister Co.',
  'American Eagle',
  'Aeropostale',
  'Urban Outfitters',
  'Free People',
  'Anthropologie',
  'Massimo Dutti',
  'Mango',
  'COS',
  '& Other Stories',
  'Monki',
  'Weekday',
  'Bershka',
  'Pull&Bear',
  'Stradivarius',
  'Topshop',
  'Topman',
  'River Island',
  'New Look',
  'Primark',
  'ASOS',
  'Boohoo',
  'PrettyLittleThing',
  'Missguided',
  'Nasty Gal',
  'SHEIN',
  'Forever 21',
  'Brandy Melville',
  'Reformation',
  'Aritzia',
  'Express',
  'Nordstrom',
  'Target',
  'Walmart',
  'Costco',
  // Contemporary and designer
  'Ralph Lauren',
  'Polo Ralph Lauren',
  'Tommy Hilfiger',
  'Calvin Klein',
  'Lacoste',
  'Fred Perry',
  'Ben Sherman',
  'Barbour',
  'Burberry',
  'Gucci',
  'Prada',
  'Miu Miu',
  'Chanel',
  'Dior',
  'Louis Vuitton',
  'Hermes',
  'Fendi',
  'Givenchy',
  'Balenciaga',
  'Saint Laurent Paris',
  'Yves Saint Laurent',
  'CELINE',
  'Loewe',
  'Bottega Veneta',
  'Valentino',
  'Versace',
  'Armani',
  'Emporio Armani',
  'Armani Exchange',
  'Dolce & Gabbana',
  'Moschino',
  'Vivienne Westwood',
  'Alexander McQueen',
  'Comme des Garçons',
  'Comme des Garçons Play',
  'Issey Miyake',
  'Yohji Yamamoto',
  'Junya Watanabe',
  'Undercover',
  'Kapital',
  'Maison Margiela',
  'MM6 Maison Margiela',
  'Acne Studios',
  'A.P.C.',
  'Sandro',
  'Maje',
  'The Kooples',
  'AllSaints',
  'Ted Baker',
  'Paul Smith',
  'Hugo Boss',
  'BOSS',
  'Moncler',
  'Canada Goose',
  'Stone Island',
  'CP Company',
  'Belstaff',
  'Coach',
  'Kate Spade New York ',
  'Michael Kors',
  'Tory Burch',
  'Longchamp',
  'Mulberry',
  'Furla',
  'Marc Jacobs',
  'Rebecca Minkoff',
  'MCM',
  'Goyard',
  'Balmain',
  'Kenzo',
  'Isabel Marant',
  'Ganni',
  'Staud',
  'Rixo',
  'Zimmermann',
  'Self-portrait',
  'Skims',
  'Ba&sh',
  'Claudie Pierlot',
  'Whistles',
  'Reiss',
  'Karen Millen',
  'Coast',
  'Hobbs',
  'Jigsaw',
  'Joules',
  'Superdry',
  'Jack Wills',
  'FatFace',
  'White Stuff',
  'Seasalt',
  'Monsoon',
  'Oasis',
  'Warehouse',
  // Watches, jewelry, eyewear
  'Rolex',
  'Omega',
  'Cartier',
  'Tiffany & Co.',
  'Swarovski',
  'PANDORA',
  'Casio',
  'G-Shock',
  'Seiko',
  'Citizen',
  'Timex',
  'Fossil',
  'Swatch',
  'Garmin',
  'Fitbit',
  'Ray-Ban',
  'Oakley',
  'Persol',
  'Gentle Monster',
  // Electronics, cameras, gaming
  'Apple',
  'Samsung',
  'Sony',
  'Nintendo',
  'Xbox',
  'Sega',
  'Bose',
  'JBL',
  'Beats by Dre',
  'Canon',
  'Nikon',
  'Fujifilm',
  'Polaroid',
  'Kodak',
  'Leica',
  'Olympus',
  'Pentax',
  // Music
  'Fender',
  'Gibson',
  'Yamaha',
  'Marshall',
  // Home
  'IKEA',
  'Crate and Barrel',
  'Pyrex',
  'Pendleton',
  'Laura Ashley',
  'Cath Kidston',
  'Emma Bridgewater',
  'Habitat',
  'Dunelm',
  'Zara Home',
  // Toys, collectibles, media
  'Lego',
  'Barbie',
  'Hot Wheels',
  'Pokémon',
  'Funko',
  'Nerf',
  'Disney',
  'Marvel',
  'Star Wars',
  'Harry Potter',
  'Sanrio',
  'Hello Kitty',
  'Squishmallows',
  'Build-A-Bear',
  'Jellycat',
  'Steiff',
  'Sylvanian Families',
  'American Girl',
  'Monster High',
  'Bratz',
  'Littlest Pet Shop',
  'My Little Pony',
  // Outdoors, sports equipment, luggage
  'Yeti',
  'Stanley',
  'Osprey',
  'Deuter',
  'Jansport',
  'Eastpak',
  'Herschel',
  'Fjällräven',
  'Samsonite',
  'Tumi',
  'Away',
  'Rimowa',
  'Wilson',
  'Spalding',
  'Callaway',
  'Titleist',
  'TaylorMade',
  'Babolat',
  'Head',
  'Dunlop',
  'Slazenger',
  'Burton',
  'K2',
  'Rossignol',
  // Beauty
  'Charlotte Tilbury',
  'Fenty Beauty',
  'Glossier',
  'The Ordinary',
  'Estée Lauder',
  'Clinique',
  'Lancôme',
  'Dyson',
  'Bath & Body Works',
  "Victoria's Secret",
  'The Body Shop',
  'Rare Beauty',
  'NARS',
  'Urban Decay',
  'Too Faced',
  'Anastasia Beverly Hills',
  'Maybelline',
  "L'Oréal",
  'NYX',
  'e.l.f.',
  'Morphe',
  'Huda Beauty',
  'Jo Malone',
  'Byredo',
  'Le Labo',
  'Diptyque',
  'Benefit',
];

const brandSlugByLabel = new Map(dropdowns.B.map((line) => Object.values(parseLabeled(line))));
const brands = [];
const seenBrands = new Set();
for (const label of CURATED_BRAND_LABELS) {
  if (seenBrands.has(label)) fail(`duplicate curated brand '${label}'`);
  seenBrands.add(label);
  const slug = brandSlugByLabel.get(label);
  if (!slug) fail(`curated brand '${label}' not found in the Depop brand vocabulary`);
  brands.push({ label: label.trim(), value: slug });
}

// ---------------------------------------------------------------------------
// Write outputs
// ---------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
const write = (name, data) => {
  writeFileSync(join(outDir, name), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote src/config/taxonomy/${name}`);
};
write('taxonomy-tree.v2.json', tree);
write('size-charts.v2.json', sizeCharts);
write('vocabularies.v2.json', vocabularies);
write('brands.v2.json', brands);

console.log(`tree: ${tree.length} top-level categories, ${allIds.size} nodes total`);
console.log(`size charts: ${Object.keys(sizeCharts).length}, sized leaves: ${sizeChartByLeafId.size}`);
console.log(
  `vocabularies: colors=${vocabularies.colors.length} sources=${vocabularies.sources.length} ages=${vocabularies.ages.length} styles=${vocabularies.styles.length}`,
);
console.log(`brands: ${brands.length}`);
