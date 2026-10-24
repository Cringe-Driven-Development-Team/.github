import { githubReview } from './github';
import type { Store, Delivery, OutgoingMessage } from './store';

export class ReviewGroups {
  constructor(private readonly store: Store) {}

  record(delivery: Delivery, now: number): void {
    const review = githubReview(delivery);
    if (review) this.store.recordReview(delivery.id, review, now);
  }

  async releaseDue(now: number, project: (deliveries: Delivery[]) => Promise<OutgoingMessage[]>): Promise<number> {
    let released = 0;
    for (const group of this.store.dueReviewGroups(now)) {
      // GitHub enrichment must finish outside the SQLite transaction. A new
      // comment/verdict invalidates this snapshot before any outbox row is written.
      const messages = await project(group.deliveries);
      if (this.store.releaseReviewGroup(group.id, group.revision, messages, now)) released++;
    }
    return released;
  }
}
