export type Venue = {
  id: string;
  name: string;
  priority?: number; // lower = more preferred
  health?: number; // 0..100
  weight?: number; // routing weight
};

export class VenueRouter {
  private venues: Venue[] = [];

  constructor(initial?: Venue[]) {
    if (initial && initial.length) this.venues = initial.map(v => ({ health: 100, weight: 1, ...v }));
  }

  list(): Venue[] { return this.venues.slice().sort((a,b) => (a.priority||0) - (b.priority||0)); }

  addVenue(v: Venue) { this.venues.push({ health: 100, weight: 1, ...v }); }

  getBestVenue(symbol?: string): Venue | null {
    // pick highest-priority healthy venue
    const candidates = this.venues.filter(v => (v.health ?? 0) > 20).sort((a,b) => (a.priority||0) - (b.priority||0));
    return candidates.length ? candidates[0] : null;
  }

  markFailure(venueId: string, penalty = 10) {
    const v = this.venues.find(x => x.id === venueId);
    if (!v) return;
    v.health = Math.max(0, (v.health ?? 100) - penalty);
  }

  markSuccess(venueId: string, reward = 2) {
    const v = this.venues.find(x => x.id === venueId);
    if (!v) return;
    v.health = Math.min(100, (v.health ?? 100) + reward);
  }

  // Failover iterator: returns next venue after a failure
  getNextVenue(afterId?: string): Venue | null {
    const ordered = this.list();
    if (!afterId) return ordered.length ? ordered[0] : null;
    const idx = ordered.findIndex(v => v.id === afterId);
    for (let i = idx + 1; i < ordered.length; i++) {
      if ((ordered[i].health ?? 0) > 20) return ordered[i];
    }
    return null;
  }
}

export default VenueRouter;
