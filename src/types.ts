export type TriggerKind = "maturity" | "cash_poor" | "permit" | "lien";
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
}

export interface IngestionRun {
  connector: string;
  status: "ok" | "partial" | "failed" | "running";
  finishedAt: string;
  rowsIngested: number;
  attempts: number;
}
