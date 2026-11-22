// Editorial groups reviewed against the EVsare catalog. Explicit emplacement IDs only:
// neither a similar name nor nearby coordinates add a new site to these groups.
const groups = []; // Add only reviewed, deployment-private groups outside this public source.

const bySite = new Map();
for (const [id, name, members] of groups) {
  for (const [site, label] of Object.entries(members)) {
    if (bySite.has(site)) throw new Error(`Duplicate map group member: ${site}`);
    bySite.set(site, Object.freeze({ id, name, label }));
  }
}

export function evsareMapGroup(siteId) { return bySite.get(siteId) ?? null; }
