/**
 * The service emits one type, `return_updated`, for request, approval, and
 * receipt. The reason lives on the order. Chronological order of the rows
 * for that order is the only way to say which step a historical row was.
 */
export function returnActivityTitle(index: number, reason: string | null): string {
  if (index <= 0) {
    const trimmed = reason?.trim() ?? '';
    return trimmed.length > 0 ? `Return requested — ${trimmed}` : 'Return requested';
  }
  if (index === 1) return 'Return approved';
  return 'Return received';
}

export function returnActivityTitles(
  events: readonly { id: string; aggregateId: string; createdAt: string }[],
  reasonsByOrderId: ReadonlyMap<string, string | null>,
  ordersLoaded: boolean,
): Map<string, string> {
  const grouped = new Map<string, { id: string; createdAt: string }[]>();
  for (const event of events) {
    const orderId = event.aggregateId.startsWith('order:') ? event.aggregateId.slice('order:'.length) : '';
    const list = grouped.get(orderId) ?? [];
    list.push({ id: event.id, createdAt: event.createdAt });
    grouped.set(orderId, list);
  }
  const titles = new Map<string, string>();
  for (const [orderId, list] of grouped) {
    const sorted = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const known = ordersLoaded && reasonsByOrderId.has(orderId);
    sorted.forEach((event, index) => {
      titles.set(
        event.id,
        known ? returnActivityTitle(index, reasonsByOrderId.get(orderId) ?? null) : 'Return updated',
      );
    });
  }
  return titles;
}
