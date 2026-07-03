/**
 * Demo dataset mirroring db/seed.sql — served by the API layer whenever the
 * Worker isn't reachable (local UI dev, static preview). Dates are computed
 * relative to "now" so trigger windows always look live.
 */

import type { BorrowerNetwork, BorrowerResume, IngestionRun, Kpis, TriggerItem } from "../types";
import { daysFromNow } from "../lib/format";

const entities = {
  sunbelt: {
    id: "ent_01", name: "Bushwick Equity Group LLC", kind: "llc" as const,
    principalName: "Marcus Delgado", flips36mo: 14, avgMarginPct: 21.4, velocityScore: 91,
  },
  ironwood: {
    id: "ent_02", name: "Astoria Development Partners LLC", kind: "llc" as const,
    principalName: "Priya Raman", flips36mo: 9, avgMarginPct: 18.2, velocityScore: 84,
  },
  okafor: {
    id: "ent_03", name: "Daniel Okafor", kind: "individual" as const,
    principalName: "Daniel Okafor", flips36mo: 11, avgMarginPct: 24.8, velocityScore: 88,
  },
  canyon: {
    id: "ent_04", name: "Canarsie Gate Holdings LLC", kind: "llc" as const,
    principalName: "Sofia Anand", flips36mo: 6, avgMarginPct: 15.1, velocityScore: 72,
  },
  heron: {
    id: "ent_05", name: "Blue Heron Builders LLC", kind: "llc" as const,
    principalName: "Tom Kowalski", flips36mo: 17, avgMarginPct: 19.7, velocityScore: 89,
  },
  mesa: {
    id: "ent_06", name: "Morris Park Capital LLC", kind: "llc" as const,
    principalName: "Elena Vasquez", flips36mo: 8, avgMarginPct: 22.3, velocityScore: 81,
  },
  lonestar: {
    id: "ent_07", name: "Empire Urban Infill LLC", kind: "llc" as const,
    principalName: "James Whitfield", flips36mo: 5, avgMarginPct: 17.9, velocityScore: 69,
  },
  liu: {
    id: "ent_08", name: "Grace Liu", kind: "individual" as const,
    principalName: "Grace Liu", flips36mo: 7, avgMarginPct: 26.1, velocityScore: 86,
  },
  copper: {
    id: "ent_10", name: "Crown Heights Restorations LLC", kind: "llc" as const,
    principalName: "Nina Petrov", flips36mo: 12, avgMarginPct: 20.6, velocityScore: 87,
  },
};

export const mockKpis: Kpis = {
  newLeads: 16,
  expiringLoans: { count: 7, principal: 3_936_000 },
  cashPoorEntities: 3,
  activeLiens: { count: 4, amount: 469_800 },
  permitValuation30d: 6_019_000,
  highVelocityFlippers: 6,
  sparks: {
    newLeads: [6, 9, 7, 11, 8, 13, 10, 14, 12, 15, 13, 16],
    expiringLoans: [3, 3, 4, 4, 5, 4, 6, 5, 6, 7, 7, 7],
    cashPoor: [1, 2, 1, 1, 2, 2, 3, 2, 2, 3, 3, 3],
    liens: [1, 0, 1, 2, 1, 1, 2, 3, 2, 3, 4, 4],
    flippers: [4, 4, 5, 4, 5, 5, 6, 5, 6, 6, 5, 6],
  },
};

export const mockMaturities: TriggerItem[] = [
  {
    id: "trg_01", kind: "maturity", score: 94, urgency: "critical",
    headline: "Note matures in ~52 days — originated 10 mo ago with Hudson Peak",
    payload: { principal: 331000, lender: "Hudson Peak Funding", rate: 10.9, daysToMaturity: 52 },
    detectedAt: daysFromNow(-1), status: "new", entity: entities.canyon,
    property: { address: "224 Malcolm X Blvd", city: "Brooklyn", county: "Kings", state: "NY", estValue: 486000 },
    contact: { phone: "(718) 555-0121", email: "sofia@canarsiegate.co", confidence: 0.79 },
  },
  {
    id: "trg_02", kind: "maturity", score: 92, urgency: "critical",
    headline: "$1.09M hard money note ~57 days from maturity; active mechanics lien on same asset",
    payload: { principal: 1090000, lender: "Anchor Bridge Capital", rate: 10.5, daysToMaturity: 57 },
    detectedAt: daysFromNow(-1), status: "new", entity: entities.mesa,
    property: { address: "603 Bainbridge St", city: "Brooklyn", county: "Kings", state: "NY", estValue: 1620000 },
    contact: { phone: "(347) 555-0176", email: "elena@morrisparkcap.com", confidence: 0.85 },
  },
  {
    id: "trg_03", kind: "maturity", score: 88, urgency: "hot",
    headline: "12-mo private note at 10.75% enters month 10 next week",
    payload: { principal: 742000, lender: "Hudson Peak Funding", rate: 10.75, daysToMaturity: 71 },
    detectedAt: daysFromNow(-2), status: "new", entity: entities.copper,
    property: { address: "789 Hancock St", city: "Brooklyn", county: "Kings", state: "NY", estValue: 1130000 },
    contact: { phone: "(646) 555-0165", email: "nina@crownheights.build", confidence: 0.93 },
  },
  {
    id: "trg_04", kind: "maturity", score: 86, urgency: "hot",
    headline: "Serial flipper (14 exits/36mo) holding an 11.25% bridge in month 9",
    payload: { principal: 618000, lender: "Anchor Bridge Capital", rate: 11.25, daysToMaturity: 84 },
    detectedAt: daysFromNow(-1), status: "viewed", entity: entities.sunbelt,
    property: { address: "448 Lefferts Ave", city: "Brooklyn", county: "Kings", state: "NY", estValue: 912000 },
    contact: { phone: "(718) 555-0134", email: "marcus@bushwickequity.com", confidence: 0.94 },
  },
  {
    id: "trg_05", kind: "maturity", score: 79, urgency: "hot",
    headline: "Bridge note month 9 of 12; permit activity suggests project mid-flight",
    payload: { principal: 298000, lender: "Empire State Note Co", rate: 11.5, daysToMaturity: 88 },
    detectedAt: daysFromNow(-3), status: "new", entity: entities.lonestar,
    property: { address: "91-12 95th St", city: "Queens", county: "Queens", state: "NY", estValue: 442000 },
    contact: { phone: "(929) 555-0110", email: "jw@empireinfill.com", confidence: 0.82 },
  },
  {
    id: "trg_06", kind: "maturity", score: 77, urgency: "warm",
    headline: "High-margin flipper in month 8; refi window opening",
    payload: { principal: 505000, lender: "Empire State Note Co", rate: 11.9, daysToMaturity: 109 },
    detectedAt: daysFromNow(-2), status: "new", entity: entities.okafor,
    property: { address: "19-17 Ditmars Blvd", city: "Queens", county: "Queens", state: "NY", estValue: 748000 },
    contact: { phone: "(917) 555-0197", email: "d.okafor@gmail.com", confidence: 0.88 },
  },
  {
    id: "trg_07", kind: "maturity", score: 74, urgency: "warm",
    headline: "12.1% private note in month 8 — rate-relief refi candidate",
    payload: { principal: 352000, lender: "Gotham Private Lending", rate: 12.1, daysToMaturity: 93 },
    detectedAt: daysFromNow(-4), status: "new", entity: entities.liu,
    property: { address: "1174 Boston Rd", city: "Bronx", county: "Bronx", state: "NY", estValue: 517000 },
    contact: { phone: "(347) 555-0143", email: "grace.liu.re@gmail.com", confidence: 0.9 },
  },
];

export const mockCashPoor: TriggerItem[] = [
  {
    id: "trg_08", kind: "cash_poor", score: 90, urgency: "critical",
    headline: "$2.68M deployed cash across 3 buys in 41 days — delayed-financing window open on all three",
    payload: { cashDeployed: 2677000, buys: 3, windowDays: 41 },
    detectedAt: daysFromNow(-1), status: "new", entity: entities.ironwood,
    property: { address: "22-05 31st Ave", city: "Queens", county: "Queens", state: "NY", estValue: 2850000 },
    contact: { phone: "(347) 555-0182", email: "praman@astoriadev.com", confidence: 0.91 },
  },
  {
    id: "trg_09", kind: "cash_poor", score: 85, urgency: "hot",
    headline: "$1.67M cash across 2 buys in 24 days while carrying 2 ground-up permits",
    payload: { cashDeployed: 1673000, buys: 2, windowDays: 24 },
    detectedAt: daysFromNow(-1), status: "new", entity: entities.heron,
    property: { address: "842 E 224th St", city: "Bronx", county: "Bronx", state: "NY", estValue: 1980000 },
    contact: { phone: "(718) 555-0158", email: "tom@blueheronbuild.com", confidence: 0.96 },
  },
  {
    id: "trg_10", kind: "cash_poor", score: 76, urgency: "warm",
    headline: "$1.01M cash across 2 buys in 52 days incl. tax-sale acquisition",
    payload: { cashDeployed: 1009000, buys: 2, windowDays: 52 },
    detectedAt: daysFromNow(-2), status: "new", entity: entities.okafor,
    property: { address: "160-05 89th Ave", city: "Queens", county: "Queens", state: "NY", estValue: 538000 },
    contact: { phone: "(917) 555-0197", email: "d.okafor@gmail.com", confidence: 0.88 },
  },
];

export const mockPermits: TriggerItem[] = [
  {
    id: "trg_11", kind: "permit", score: 89, urgency: "hot",
    headline: "$2.35M ground-up 8-unit filed 11 days ago; LLC matched, principal skip-traced",
    payload: { valuation: 2350000, permitType: "ground_up", permitNo: "2026-BP-18834", filedDaysAgo: 11 },
    detectedAt: daysFromNow(-1), status: "new", entity: entities.ironwood,
    property: { address: "22-05 31st Ave", city: "Queens", county: "Queens", state: "NY", estValue: 2850000 },
    contact: { phone: "(347) 555-0182", email: "praman@astoriadev.com", confidence: 0.91 },
  },
  {
    id: "trg_12", kind: "permit", score: 84, urgency: "hot",
    headline: "$1.64M 6-unit townhome cluster in review; owner-builder",
    payload: { valuation: 1640000, permitType: "ground_up", permitNo: "MIA-26-22093", filedDaysAgo: 19 },
    detectedAt: daysFromNow(-2), status: "new", entity: entities.heron,
    property: { address: "842 E 224th St", city: "Bronx", county: "Bronx", state: "NY", estValue: 1980000 },
    contact: { phone: "(718) 555-0158", email: "tom@blueheronbuild.com", confidence: 0.96 },
  },
  {
    id: "trg_13", kind: "permit", score: 80, urgency: "warm",
    headline: "$1.18M new SFR + ADU filed 6 days ago",
    payload: { valuation: 1180000, permitType: "ground_up", permitNo: "BLD-26-04412", filedDaysAgo: 6 },
    detectedAt: daysFromNow(-1), status: "new", entity: entities.heron,
    property: { address: "331 Bement Ave", city: "Staten Island", county: "Richmond", state: "NY", estValue: 2210000 },
    contact: { phone: "(718) 555-0158", email: "tom@blueheronbuild.com", confidence: 0.96 },
  },
  {
    id: "trg_14", kind: "permit", score: 73, urgency: "warm",
    headline: "$487K structural gut issued; same asset carries maturing note",
    payload: { valuation: 487000, permitType: "structural", permitNo: "2026-BP-17501", filedDaysAgo: 15 },
    detectedAt: daysFromNow(-3), status: "viewed", entity: entities.mesa,
    property: { address: "603 Bainbridge St", city: "Brooklyn", county: "Kings", state: "NY", estValue: 1620000 },
    contact: { phone: "(347) 555-0176", email: "elena@morrisparkcap.com", confidence: 0.85 },
  },
];

export const mockLiens: TriggerItem[] = [
  {
    id: "trg_15", kind: "lien", score: 93, urgency: "critical",
    headline: "$211.7K steel lien filed 2 days ago on active 6-unit build — draw likely frozen",
    payload: { amount: 211700, claimant: "Biscayne Steel Erectors", filedDaysAgo: 2 },
    detectedAt: daysFromNow(0), status: "new", entity: entities.heron,
    property: { address: "842 E 224th St", city: "Bronx", county: "Bronx", state: "NY", estValue: 1980000 },
    contact: { phone: "(718) 555-0158", email: "tom@blueheronbuild.com", confidence: 0.96 },
  },
  {
    id: "trg_16", kind: "lien", score: 91, urgency: "critical",
    headline: "$148.5K GC lien on Brooklyn gut reno; note matures in ~57 days",
    payload: { amount: 148500, claimant: "Sunline Construction Inc", filedDaysAgo: 3 },
    detectedAt: daysFromNow(-1), status: "new", entity: entities.mesa,
    property: { address: "603 Bainbridge St", city: "Brooklyn", county: "Kings", state: "NY", estValue: 1620000 },
    contact: { phone: "(347) 555-0176", email: "elena@morrisparkcap.com", confidence: 0.85 },
  },
  {
    id: "trg_17", kind: "lien", score: 82, urgency: "hot",
    headline: "$86.2K concrete lien on new 8-unit; entity also cash-poor",
    payload: { amount: 86200, claimant: "Capital City Concrete LLC", filedDaysAgo: 7 },
    detectedAt: daysFromNow(-2), status: "new", entity: entities.ironwood,
    property: { address: "22-05 31st Ave", city: "Queens", county: "Queens", state: "NY", estValue: 2850000 },
    contact: { phone: "(347) 555-0182", email: "praman@astoriadev.com", confidence: 0.91 },
  },
  {
    id: "trg_18", kind: "lien", score: 61, urgency: "warm",
    headline: "$23.4K plumbing lien (disputed) on bridge-financed flip",
    payload: { amount: 23400, claimant: "Delgado Bros Plumbing", filedDaysAgo: 12 },
    detectedAt: daysFromNow(-5), status: "viewed", entity: entities.sunbelt,
    property: { address: "448 Lefferts Ave", city: "Brooklyn", county: "Kings", state: "NY", estValue: 912000 },
    contact: { phone: "(718) 555-0134", email: "marcus@bushwickequity.com", confidence: 0.94 },
  },
];

export const mockIngestion: IngestionRun[] = [
  { connector: "county_deeds", status: "ok", finishedAt: daysFromNow(0), rowsIngested: 1284, attempts: 1 },
  { connector: "county_loans", status: "ok", finishedAt: daysFromNow(0), rowsIngested: 402, attempts: 1 },
  { connector: "permits", status: "ok", finishedAt: daysFromNow(0), rowsIngested: 356, attempts: 2 },
  { connector: "liens", status: "ok", finishedAt: daysFromNow(0), rowsIngested: 88, attempts: 1 },
  { connector: "skip_trace", status: "partial", finishedAt: daysFromNow(0), rowsIngested: 61, attempts: 3 },
  { connector: "scoring", status: "ok", finishedAt: daysFromNow(0), rowsIngested: 18, attempts: 1 },
];

/* --------------------- borrower network (cross-LLC) --------------------- */
/* Principals frequently operate several LLCs; the network graph is how a
   lender learns the customer, not just the entity on today's deed. */

const PRINCIPAL_LINKS: Record<string, { principal: string; entityIds: string[] }> = {
  "Marcus Delgado": { principal: "Marcus Delgado", entityIds: ["ent_01", "ent_04"] },
  "Priya Raman": { principal: "Priya Raman", entityIds: ["ent_02", "ent_07"] },
  "Tom Kowalski": { principal: "Tom Kowalski", entityIds: ["ent_05", "ent_09"] },
};

const NETWORK_STATS: Record<string, { volume36mo: number }> = {
  ent_01: { volume36mo: 6_840_000 }, ent_02: { volume36mo: 9_120_000 },
  ent_04: { volume36mo: 3_380_000 }, ent_05: { volume36mo: 11_260_000 },
  ent_07: { volume36mo: 7_450_000 }, ent_09: { volume36mo: 2_140_000 },
};

const EXTRA_ENTITIES: Record<string, { id: string; name: string; kind: "llc"; flips36mo: number; velocityScore: number }> = {
  ent_09: { id: "ent_09", name: "Pelham Ridge Ventures LLC", kind: "llc", flips36mo: 4, velocityScore: 58 },
};

export function networkFor(entityId: string): BorrowerNetwork | null {
  const link = Object.values(PRINCIPAL_LINKS).find((l) => l.entityIds.includes(entityId));
  if (!link) return null;
  const others = link.entityIds
    .filter((id) => id !== entityId)
    .map((id) => {
      const known = Object.values(entities).find((e) => e.id === id) ?? EXTRA_ENTITIES[id];
      if (!known) return null;
      return {
        id: known.id,
        name: known.name,
        kind: known.kind,
        flips36mo: known.flips36mo,
        volume36mo: NETWORK_STATS[id]?.volume36mo ?? 0,
        velocityScore: known.velocityScore,
        role: "Managing member",
      };
    })
    .filter((e): e is NonNullable<typeof e> => e != null);
  return others.length ? { principalName: link.principal, entities: others } : null;
}

/* ------------------------- borrower resumes ------------------------- */

const resumeBase = (
  e: (typeof entities)[keyof typeof entities],
  extra: Partial<BorrowerResume["entity"]>
): BorrowerResume["entity"] => ({
  ...e,
  state: "NY",
  formationDate: null,
  registeredAgent: null,
  avgHoldDays: 130,
  volume36mo: 5_000_000,
  ...extra,
});

export const mockResumes: Record<string, BorrowerResume> = {
  ent_01: {
    entity: resumeBase(entities.sunbelt, {
      state: "NY", formationDate: "2019-03-11", registeredAgent: "Cogency Global",
      avgHoldDays: 127, volume36mo: 6_840_000,
    }),
    contacts: [
      { name: "Marcus Delgado", title: "Managing Member", phone: "(718) 555-0134", email: "marcus@bushwickequity.com", linkedin: "linkedin.com/in/marcusdelgado-re", source: "skip_trace", confidence: 0.94, verifiedAt: daysFromNow(-12) },
    ],
    transactions: [
      { id: "trx_10", side: "purchase", price: 655000, isCash: false, address: "448 Lefferts Ave", city: "Brooklyn", state: "NY", recordedAt: daysFromNow(-276) },
      { id: "trx_09", side: "sale", price: 689000, isCash: false, address: "410 Quincy St", city: "Brooklyn", state: "NY", recordedAt: daysFromNow(-455) },
      { id: "trx_08", side: "purchase", price: 521000, isCash: false, address: "410 Quincy St", city: "Brooklyn", state: "NY", recordedAt: daysFromNow(-668) },
      { id: "trx_h1", side: "sale", price: 574000, isCash: false, address: "312 Putnam Ave", city: "Brooklyn", state: "NY", recordedAt: daysFromNow(-540) },
      { id: "trx_h2", side: "purchase", price: 431000, isCash: true, address: "312 Putnam Ave", city: "Brooklyn", state: "NY", recordedAt: daysFromNow(-702) },
      { id: "trx_h3", side: "sale", price: 812000, isCash: false, address: "561 Madison St", city: "Brooklyn", state: "NY", recordedAt: daysFromNow(-798) },
      { id: "trx_h4", side: "purchase", price: 622000, isCash: false, address: "561 Madison St", city: "Brooklyn", state: "NY", recordedAt: daysFromNow(-940) },
    ],
    loans: [
      { id: "lon_01", lenderName: "Anchor Bridge Capital", lenderType: "hard_money", principal: 618000, ratePct: 11.25, originatedAt: daysFromNow(-276), maturityDate: daysFromNow(84), status: "active", address: "448 Lefferts Ave" },
      { id: "lon_08", lenderName: "Anchor Bridge Capital", lenderType: "hard_money", principal: 447000, ratePct: 11.0, originatedAt: daysFromNow(-668), maturityDate: daysFromNow(-303), status: "paid_off", address: "410 Quincy St" },
    ],
    activeSignals: [
      { kind: "maturity", headline: "11.25% bridge in month 9 — $618K with Anchor Bridge", score: 86 },
      { kind: "lien", headline: "$23.4K plumbing lien (disputed)", score: 61 },
    ],
    network: networkFor("ent_01"),
  },
  ent_02: {
    entity: resumeBase(entities.ironwood, {
      state: "NY", formationDate: "2017-08-02", registeredAgent: "CT Corporation",
      avgHoldDays: 164, volume36mo: 9_120_000,
    }),
    contacts: [
      { name: "Priya Raman", title: "Principal", phone: "(347) 555-0182", email: "praman@astoriadev.com", linkedin: "linkedin.com/in/priyaraman-dev", source: "skip_trace", confidence: 0.91, verifiedAt: daysFromNow(-30) },
    ],
    transactions: [
      { id: "trx_03", side: "purchase", price: 401000, isCash: true, address: "91-12 95th St", city: "Queens", state: "NY", recordedAt: daysFromNow(-9) },
      { id: "trx_02", side: "purchase", price: 866000, isCash: true, address: "55-01 Myrtle Ave", city: "Queens", state: "NY", recordedAt: daysFromNow(-26) },
      { id: "trx_01", side: "purchase", price: 1410000, isCash: true, address: "22-05 31st Ave", city: "Queens", state: "NY", recordedAt: daysFromNow(-41) },
      { id: "trx_i1", side: "sale", price: 1290000, isCash: false, address: "18-04 Astoria Blvd", city: "Queens", state: "NY", recordedAt: daysFromNow(-122) },
      { id: "trx_i2", side: "purchase", price: 940000, isCash: false, address: "18-04 Astoria Blvd", city: "Queens", state: "NY", recordedAt: daysFromNow(-410) },
    ],
    loans: [
      { id: "lon_i1", lenderName: "Empire State Note Co", lenderType: "hard_money", principal: 705000, ratePct: 11.5, originatedAt: daysFromNow(-410), maturityDate: daysFromNow(-45), status: "paid_off", address: "18-04 Astoria Blvd" },
    ],
    activeSignals: [
      { kind: "cash_poor", headline: "$2.68M cash across 3 buys in 41 days", score: 90 },
      { kind: "permit", headline: "$2.35M ground-up 8-unit filed", score: 89 },
      { kind: "lien", headline: "$86.2K concrete lien on new 8-unit", score: 82 },
    ],
    network: networkFor("ent_02"),
  },
  ent_05: {
    entity: resumeBase(entities.heron, {
      state: "NY", formationDate: "2016-05-27", registeredAgent: "NW Registered Agent",
      avgHoldDays: 151, volume36mo: 11_260_000,
    }),
    contacts: [
      { name: "Tom Kowalski", title: "Owner", phone: "(718) 555-0158", email: "tom@blueheronbuild.com", linkedin: "linkedin.com/in/tomkowalski-fl", source: "skip_trace", confidence: 0.96, verifiedAt: daysFromNow(-5) },
    ],
    transactions: [
      { id: "trx_05", side: "purchase", price: 438000, isCash: true, address: "52 Harrison Ave", city: "Staten Island", state: "NY", recordedAt: daysFromNow(-13) },
      { id: "trx_04", side: "purchase", price: 1235000, isCash: true, address: "842 E 224th St", city: "Bronx", state: "NY", recordedAt: daysFromNow(-24) },
      { id: "trx_b1", side: "sale", price: 1710000, isCash: false, address: "921 Intervale Ave", city: "Bronx", state: "NY", recordedAt: daysFromNow(-88) },
      { id: "trx_b2", side: "purchase", price: 1180000, isCash: false, address: "921 Intervale Ave", city: "Bronx", state: "NY", recordedAt: daysFromNow(-350) },
    ],
    loans: [
      { id: "lon_10", lenderName: "Gotham Private Lending", lenderType: "private", principal: 312000, ratePct: 11.75, originatedAt: daysFromNow(-426), maturityDate: daysFromNow(-61), status: "refinanced", address: "52 Harrison Ave" },
    ],
    activeSignals: [
      { kind: "lien", headline: "$211.7K steel lien — draw likely frozen", score: 93 },
      { kind: "cash_poor", headline: "$1.67M cash across 2 buys in 24 days", score: 85 },
      { kind: "permit", headline: "$1.64M 6-unit townhome cluster in review", score: 84 },
    ],
    network: networkFor("ent_05"),
  },
};

/** Fallback resume synthesized from any feed row when a full one isn't seeded. */
export function synthesizeResume(item: TriggerItem): BorrowerResume {
  // Recover the borrower's recorded notes from any maturity signal on the same
  // entity, so Cost of Capital (rates paid) renders for every prospect.
  const loans: BorrowerResume["loans"] = mockMaturities
    .filter((m) => m.entity.id === item.entity.id)
    .map((m, i) => ({
      id: `syn-${m.id}-${i}`,
      lenderName: String(m.payload.lender),
      lenderType: "hard_money",
      principal: Number(m.payload.principal),
      ratePct: Number(m.payload.rate),
      originatedAt: daysFromNow(Number(m.payload.daysToMaturity) - 365),
      maturityDate: daysFromNow(Number(m.payload.daysToMaturity)),
      status: "active",
      address: m.property?.address ?? "",
    }));

  const signals = [
    ...new Map(
      [item, ...mockMaturities, ...mockCashPoor, ...mockPermits, ...mockLiens]
        .filter((t) => t.entity.id === item.entity.id)
        .map((t) => [t.id, { kind: t.kind, headline: t.headline, score: t.score }])
    ).values(),
  ].sort((a, b) => b.score - a.score);

  return {
    entity: resumeBase(entities.sunbelt, {
      ...item.entity,
      state: item.property?.state ?? null,
      avgHoldDays: 120 + Math.round((100 - item.entity.velocityScore) * 1.4),
      volume36mo: item.entity.flips36mo * 480_000,
    }),
    contacts: item.contact
      ? [{
          name: item.entity.principalName ?? item.entity.name, title: null,
          phone: item.contact.phone, email: item.contact.email, linkedin: null,
          source: "skip_trace", confidence: item.contact.confidence, verifiedAt: null,
        }]
      : [],
    transactions: [],
    loans,
    activeSignals: signals,
    network: networkFor(item.entity.id),
  };
}
