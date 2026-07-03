export type TriggerKind = "maturity" | "cash_poor" | "permit" | "lien" | "custom";

/** How much to trust a record: two independent sources > API > AI-extracted. */
export type RecordConfidence = "corroborated" | "direct" | "extracted";

export interface RecordProvenance {
  sourceId: string | null;
  sourceUrl: string | null;
  sourceMethod: string | null; // api | scrape | seed | manual
  confidence: RecordConfidence;
}
export type Urgency = "critical" | "hot" | "warm";
export type TriggerStatus = "new" | "viewed" | "contacted" | "dismissed" | "converted";

export interface EntitySummary {
  id: string;
  name: string;
  kind: "llc" | "individual" | "trust" | "corp";
  principalName: string | null;
  flips36mo: number;
  avgMarginPct: number | null;
  velocityScore: number;
}

export interface PropertySummary {
  address: string;
  city: string;
  county: string;
  state: string;
  estValue: number | null;
  lat?: number | null;
  lng?: number | null;
}

export interface ContactSummary {
  phone: string | null;
  email: string | null;
  confidence: number;
}

export interface TriggerItem {
  id: string;
  kind: TriggerKind;
  score: number;
  urgency: Urgency;
  headline: string;
  payload: Record<string, number | string>;
  detectedAt: string;
  status: TriggerStatus;
  entity: EntitySummary;
  property: PropertySummary | null;
  contact: ContactSummary | null;
}

export interface Kpis {
  newLeads: number;
  expiringLoans: { count: number; principal: number };
  cashPoorEntities: number;
  activeLiens: { count: number; amount: number };
  permitValuation30d: number;
  highVelocityFlippers: number;
  sparks: {
    newLeads: number[];
    expiringLoans: number[];
    cashPoor: number[];
    liens: number[];
    flippers: number[];
  };
}

export interface ResumeTransaction {
  id: string;
  side: "purchase" | "sale";
  price: number;
  isCash: boolean;
  address: string;
  city: string;
  state: string;
  recordedAt: string;
}

export interface ResumeLoan {
  id: string;
  lenderName: string;
  lenderType: string;
  principal: number;
  ratePct: number | null;
  originatedAt: string;
  maturityDate: string | null;
  status: string;
  address: string;
  provenance?: RecordProvenance | null;
}

export interface ResumeContact {
  name: string;
  title: string | null;
  phone: string | null;
  email: string | null;
  linkedin: string | null;
  source: string;
  confidence: number;
  verifiedAt: string | null;
}

export interface BorrowerResume {
  entity: EntitySummary & {
    state: string | null;
    formationDate: string | null;
    registeredAgent: string | null;
    avgHoldDays: number | null;
    volume36mo: number;
  };
  contacts: ResumeContact[];
  transactions: ResumeTransaction[];
  loans: ResumeLoan[];
  activeSignals: { kind: TriggerKind; headline: string; score: number }[];
  network?: BorrowerNetwork | null;
}

/* ------------------------------ CRM ------------------------------ */

export type PipelineStage = "watching" | "outreach" | "term_sheet" | "funded" | "lost";

export interface LeadActivity {
  ts: string; // ISO datetime
  kind: "added" | "stage" | "note" | "call" | "email" | "follow_up";
  text: string;
}

export interface Lead {
  entityId: string;
  entityName: string; // snapshot at save time so the board renders independently of feeds
  stage: PipelineStage;
  note: string;
  followUp: string | null; // ISO date
  dealValue: number | null; // manual override; falls back to signal estimate
  addedAt: string;
  activities: LeadActivity[];
}

/** Another entity controlled by the same principal — the cross-LLC graph. */
export interface NetworkEntity {
  id: string;
  name: string;
  kind: "llc" | "individual" | "trust" | "corp";
  flips36mo: number;
  volume36mo: number;
  velocityScore: number;
  role: string | null;
}

export interface BorrowerNetwork {
  principalName: string;
  entities: NetworkEntity[];
}

export interface UnderwritingDefaults {
  rateSpread: number; // quote = borrower's last rate − spread
  points: number;
  termMonths: number;
  maxLtv: number;
  minLoan: number;
  lenderName: string;
  validDays: number;
}

export interface OutreachDefaults {
  senderName: string;
  company: string;
  signature: string;
  defaultChannel: "email" | "sms";
}

export interface PublicSettings {
  dataMode: "demo" | "live";
  markets: string[];
  aiEnabled: boolean;
  aiGatewayId: string;
  scrapingConfigured: boolean;
  alertsEnabled: boolean;
  alertEmail: string;
  alertsConfigured: boolean;
  underwriting: UnderwritingDefaults | null;
  outreach: OutreachDefaults | null;
}

export interface ConnectorInfo {
  id: string;
  label: string;
  enabled: boolean;
  mode: "api" | "scrape";
  baseUrl: string | null;
  scrapeUrl: string | null;
  notes: string | null;
  fieldMap: string | null;
  isSocrata: boolean;
  apiKeyLast4: string | null;
  lastRun: { status: string; finishedAt: string | null; rowsIngested: number } | null;
}

export interface IngestionRun {
  connector: string;
  status: "ok" | "partial" | "failed" | "running";
  finishedAt: string;
  rowsIngested: number;
  attempts: number;
}

/* --------------------- competitor intelligence --------------------- */

export interface LenderRow {
  lenderName: string;
  loans: number;
  uccFilings: number;
  volume: number;
  avgRate: number | null;
  maturing90d: number;
  maturingVolume: number;
  payoffs90d: number;
}

export interface LenderLoan {
  id: string;
  principal: number;
  ratePct: number | null;
  originatedAt: string;
  maturity: string | null;
  status: string;
  instrument: string;
  entityId: string | null;
  entityName: string | null;
  flips36mo: number | null;
  velocityScore: number | null;
  address: string | null;
  city: string | null;
  sourceUrl: string | null;
  confidence: RecordConfidence;
}

/* --------------------------- loan book --------------------------- */

export type LoanBookStatus = "current" | "late" | "extended" | "paid_off" | "defaulted";

export interface LoanBookEntry {
  id: string;
  entityId: string | null;
  entityName?: string | null;
  borrowerName: string;
  propertyAddress: string | null;
  principal: number;
  ratePct: number;
  points: number | null;
  originatedAt: string;
  termMonths: number;
  maturityDate: string | null;
  status: LoanBookStatus;
  notes: string | null;
}

/* ------------------------- data integrity ------------------------- */

export interface QuarantineRow {
  id: string;
  connector: string;
  recordKind: string;
  payload: Record<string, unknown>;
  reasons: string[];
  sourceUrl: string | null;
  createdAt: string;
}

export interface MergeSuggestion {
  id: string;
  nameA: string;
  nameB: string;
  reason: string;
  score: number;
}

export interface SourceAnomaly {
  connector: string;
  today: number;
  baseline: number;
}

export interface DataQuality {
  pendingQuarantine: number;
  quarantined7d: number;
  ingested7d: number;
  anomalies: SourceAnomaly[];
  quarantine: QuarantineRow[];
  merges: MergeSuggestion[];
}

/* ------------------------- custom signals ------------------------- */

export interface CustomSignal {
  id: string;
  name: string;
  prompt: string;
  rule: Record<string, unknown>;
  enabled: boolean;
  lastRunAt: string | null;
  totalHits: number;
}

/* --------------------------- backfill --------------------------- */

export interface BackfillRow {
  connector: string;
  status: "idle" | "running" | "done" | "error";
  cursorDate: string | null;
  targetDate: string | null;
  rowsTotal: number;
  error: string | null;
  pctComplete: number;
}
