// Made-up independent guides on the south-west coast of Mauritius. Every name is invented and ends in
// "(demo)"; none is a real business or person. Payees are placeholder sandbox addresses: on the hosted
// sandbox, PAYPAL_GUIDE_PAYEE_EMAIL (or _MERCHANT_ID) points every guide at one sandbox business account.

import type { CurrencyCode, Payee } from "../paypal/types.ts";

export interface Guide {
  id: string;
  name: string;
  /** Places the guide works, as travellers say them. */
  areas: string[];
  activities: string[];
  languages: string[];
  bio: string;
  /** What the guide usually charges per person, for the agent's expectations only; the guide sets the real price. */
  typical_price_per_person: number;
  currency: CurrencyCode;
  payee: Payee;
}

export const SEED_GUIDES: readonly Guide[] = [
  {
    id: "g_lantern",
    name: "Lantern Ridge Walks (demo)",
    areas: ["Le Morne", "Le Morne Brabant"],
    activities: ["hike", "sunrise hike"],
    languages: ["en", "fr", "kreol"],
    bio: "Small-group sunrise climbs of Le Morne Brabant, starting at the trailhead car park.",
    typical_price_per_person: 40,
    currency: "EUR",
    payee: { email_address: "lantern-ridge@business.sandbox.example" },
  },
  {
    id: "g_quillfeather",
    name: "Quillfeather Trails (demo)",
    areas: ["Le Morne", "Black River Gorges"],
    activities: ["hike", "birdwatching"],
    languages: ["en", "fr"],
    bio: "Slow hikes with stops for endemic birds; binoculars provided.",
    typical_price_per_person: 35,
    currency: "EUR",
    payee: { email_address: "quillfeather@business.sandbox.example" },
  },
  {
    id: "g_saltpan",
    name: "Saltpan & Summit Guides (demo)",
    areas: ["Black River Gorges", "Tamarin"],
    activities: ["hike", "canyoning"],
    languages: ["en", "fr", "de"],
    bio: "Gorge hikes and beginner canyoning, helmets and harnesses included.",
    typical_price_per_person: 55,
    currency: "EUR",
    payee: { email_address: "saltpan-summit@business.sandbox.example" },
  },
  {
    id: "g_tidecount",
    name: "Tidecount Kayak (demo)",
    areas: ["Le Morne", "La Gaulette"],
    activities: ["kayak", "snorkel"],
    languages: ["en", "fr"],
    bio: "Lagoon kayak mornings with a snorkel stop when the tide allows.",
    typical_price_per_person: 45,
    currency: "EUR",
    payee: { email_address: "tidecount-kayak@business.sandbox.example" },
  },
  {
    id: "g_ebonyleaf",
    name: "Ebonyleaf Forest Walks (demo)",
    areas: ["Black River Gorges", "Chamarel"],
    activities: ["hike", "plant walk"],
    languages: ["en", "fr", "it"],
    bio: "Native-forest walks about ebony, tambalacoque and medicinal plants.",
    typical_price_per_person: 30,
    currency: "EUR",
    payee: { email_address: "ebonyleaf@business.sandbox.example" },
  },
];

/** The seed with every payee replaced, when one sandbox business account plays all the guides. */
export function guidesWithPayee(override: Payee | undefined, seed: readonly Guide[] = SEED_GUIDES): Guide[] {
  return seed.map((g) => (override ? { ...g, payee: override } : { ...g }));
}

function norm(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

export interface GuideQuery {
  area?: string;
  activity?: string;
  language?: string;
}

/** Guides matching every given filter (substring, accent- and case-insensitive). */
export function searchGuides(guides: readonly Guide[], q: GuideQuery): Guide[] {
  const has = (list: string[], v: string | undefined) => !v || list.some((x) => norm(x).includes(norm(v)) || norm(v).includes(norm(x)));
  return guides.filter((g) => has(g.areas, q.area) && has(g.activities, q.activity) && has(g.languages, q.language));
}
