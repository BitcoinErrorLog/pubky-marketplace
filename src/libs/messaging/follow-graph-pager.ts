/**
 * Walks one account's Nexus follower (or following) list a page per inbox
 * sync pass, wrapping to the first page after the last one.
 *
 * Nexus serves these lists from an unordered set, so the first page is an
 * arbitrary, stable subset: a follower who is not on it is never named if
 * only that page is read. Reading the next page each pass names every
 * follower within one cycle while each pass still costs one page.
 */
export class FollowGraphPager {
  private skip = 0;
  private currentCycle = new Set<string>();
  private previousCycle = new Set<string>();

  constructor(private readonly pageSize: number) {}

  /** Where the next page starts. */
  nextSkip(): number {
    return this.skip;
  }

  /**
   * Records the page read at {@link nextSkip}. A short page, or an empty one
   * past the end, completes the cycle and the next read starts over.
   */
  record(page: readonly string[]): void {
    for (const pubky of page) this.currentCycle.add(pubky);
    if (page.length < this.pageSize) {
      this.previousCycle = this.currentCycle;
      this.currentCycle = new Set();
      this.skip = 0;
      return;
    }
    this.skip += page.length;
  }

  /**
   * Everyone read during the current or the last complete cycle. Someone
   * who left the list drops out once a whole cycle has passed without them.
   */
  seen(): Set<string> {
    return new Set([...this.previousCycle, ...this.currentCycle]);
  }
}
