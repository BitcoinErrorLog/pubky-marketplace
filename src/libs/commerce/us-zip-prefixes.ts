/**
 * USPS ZIP code prefixes (first three digits) → ISO 3166-2 state/territory
 * suffix. Public postal assignment, not a third-party dataset.
 */
const ZIP3_RANGES: ReadonlyArray<readonly [number, number, string]> = [
  [5, 5, 'NY'],
  [6, 9, 'PR'],
  [10, 27, 'MA'],
  [28, 29, 'RI'],
  [30, 38, 'NH'],
  [39, 49, 'ME'],
  [50, 59, 'VT'],
  [60, 69, 'CT'],
  [70, 89, 'NJ'],
  [90, 98, 'AE'],
  [100, 149, 'NY'],
  [150, 196, 'PA'],
  [197, 199, 'DE'],
  [200, 205, 'DC'],
  [206, 219, 'MD'],
  [220, 246, 'VA'],
  [247, 268, 'WV'],
  [270, 289, 'NC'],
  [290, 299, 'SC'],
  [300, 319, 'GA'],
  [320, 339, 'FL'],
  [340, 340, 'AA'],
  [341, 349, 'FL'],
  [350, 369, 'AL'],
  [370, 385, 'TN'],
  [386, 397, 'MS'],
  [398, 399, 'GA'],
  [400, 427, 'KY'],
  [430, 459, 'OH'],
  [460, 479, 'IN'],
  [480, 499, 'MI'],
  [500, 528, 'IA'],
  [530, 549, 'WI'],
  [550, 567, 'MN'],
  [570, 577, 'SD'],
  [580, 588, 'ND'],
  [590, 599, 'MT'],
  [600, 629, 'IL'],
  [630, 658, 'MO'],
  [660, 679, 'KS'],
  [680, 693, 'NE'],
  [700, 714, 'LA'],
  [716, 729, 'AR'],
  [730, 749, 'OK'],
  [750, 799, 'TX'],
  [800, 816, 'CO'],
  [820, 831, 'WY'],
  [832, 838, 'ID'],
  [840, 847, 'UT'],
  [850, 865, 'AZ'],
  [870, 884, 'NM'],
  [889, 898, 'NV'],
  [900, 961, 'CA'],
  [962, 966, 'AP'],
  [967, 968, 'HI'],
  [969, 969, 'GU'],
  [970, 979, 'OR'],
  [980, 994, 'WA'],
  [995, 999, 'AK'],
];

export function zip3ToState(zip3: string): string | null {
  const n = Number.parseInt(zip3, 10);
  if (!Number.isInteger(n) || n < 0 || n > 999) return null;
  for (const [start, end, state] of ZIP3_RANGES) {
    if (n >= start && n <= end) return state;
  }
  return null;
}
