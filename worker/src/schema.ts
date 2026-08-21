/**
 * Record shapes, defined once.
 *
 * These used to live as hand-written strings in the extraction prompts,
 * which meant the model was asked to produce clean JSON by prompt
 * discipline alone and a regex decided whether it had. That is expensive in
 * two ways: it wastes tokens re-describing the shape, and it needs a strong
 * model to be reliable at all — a smaller model's output gets thrown away
 * by the parser rather than being merely imperfect.
 *
 * Declaring each shape once buys both halves: a real JSON Schema for
 * Workers AI's JSON mode (so the model is *constrained* rather than asked
 * nicely), and the compact prompt hint generated from the same source, so
 * the two can never drift.
 */

/** A field in a record shape. Deliberately small — this is not a JSON Schema DSL. */
export type Field =
  | { t: "string"; nullable?: boolean; enum?: readonly string[]; hint?: string }
  | { t: "number"; nullable?: boolean }
  | { t: "boolean"; nullable?: boolean };

export type Shape = Record<string, Field>;

export interface JsonSchema {
  type: string | string[];
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  additionalProperties?: boolean;
}

function fieldSchema(f: Field): Record<string, unknown> {
  const type = f.nullable ? [f.t, "null"] : f.t;
  if (f.t === "string" && f.enum) return { type, enum: f.nullable ? [...f.enum, null] : [...f.enum] };
  return { type };
}

/** JSON Schema for one record. */
export function objectSchema(shape: Shape): JsonSchema {
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(shape).map(([k, f]) => [k, fieldSchema(f)])),
    // Every field required (nullability is expressed in the type union), so a
    // model cannot quietly omit one and leave the gate to notice later.
    required: Object.keys(shape),
    additionalProperties: false,
  };
}

/**
 * JSON Schema for a list of records.
 *
 * Wrapped in an object rather than a bare top-level array: object roots are
 * the shape every JSON-mode implementation supports, and the parser accepts
 * a bare array anyway, so this costs nothing and avoids depending on
 * top-level-array support.
 */
export function listSchema(shape: Shape): JsonSchema {
  return {
    type: "object",
    properties: { records: { type: "array", items: objectSchema(shape) } },
    required: ["records"],
    additionalProperties: false,
  };
}

/** The compact `{"field":type}` hint that goes in the prompt. */
export function shapeHint(shape: Shape): string {
  const part = ([name, f]: [string, Field]) => {
    let base: string = f.t;
    if (f.t === "string" && f.enum) base = f.enum.map((v) => `"${v}"`).join("|");
    else if (f.t === "string" && f.hint) base = `"${f.hint}"`;
    return `"${name}":${base}${f.nullable ? "|null" : ""}`;
  };
  return `{${Object.entries(shape).map(part).join(",")}}`;
}

/* ------------------------------- record shapes ------------------------------- */

const DATE = { t: "string", hint: "YYYY-MM-DD" } as const;
const str = (nullable = false): Field => ({ t: "string", nullable });
const num = (nullable = false): Field => ({ t: "number", nullable });

const ADDRESS: Shape = {
  address: str(), city: str(), county: str(), state: str(),
};

const LIEN_SHAPE: Shape = {
  docNumber: str(), ...ADDRESS,
  lienType: { t: "string", nullable: true, enum: ["mechanics", "tax", "judgment", "lis_pendens", "violation", "auction"] },
  claimant: str(), amount: num(), filedAt: DATE, ownerName: str(),
};

export const RECORD_SHAPES: Record<string, Shape> = {
  county_deeds: {
    docNumber: str(), apn: str(true), ...ADDRESS, zip: str(true),
    price: num(), isCash: { t: "boolean" }, deedType: str(true),
    buyerName: str(), sellerName: str(), recordedAt: DATE,
  },
  county_loans: {
    docNumber: str(), apn: str(true), ...ADDRESS,
    lenderName: str(),
    lenderType: { t: "string", nullable: true, enum: ["private", "hard_money", "bank"] },
    principal: num(), ratePct: num(true), originatedAt: DATE,
    termMonths: num(true), maturityDate: { t: "string", nullable: true, hint: "YYYY-MM-DD" },
    borrowerName: str(),
  },
  permits: {
    permitNo: str(), ...ADDRESS,
    permitType: { t: "string", enum: ["ground_up", "structural", "addition", "remodel", "other"] },
    description: str(true), valuation: num(), filedAt: DATE,
    status: str(true), contractor: str(true), ownerName: str(),
  },
  liens: LIEN_SHAPE,
  lis_pendens: LIEN_SHAPE,
  violations: LIEN_SHAPE,
  tax_liens: LIEN_SHAPE,
  auctions: LIEN_SHAPE,
  satisfactions: {
    docNumber: str(), originalDocNumber: str(true),
    address: str(true), city: str(true), county: str(true), state: str(true),
    lenderName: str(), borrowerName: str(), satisfiedAt: DATE,
  },
  ucc_filings: {
    fileNumber: str(), securedParty: str(), debtorName: str(), filedAt: DATE,
    address: str(true), city: str(true), county: str(true), state: str(true),
    collateral: str(true),
  },
  corp_registry: {
    entityName: str(), formationDate: { t: "string", nullable: true, hint: "YYYY-MM-DD" },
    registeredAgent: str(true), county: str(true), status: str(true),
  },
};

/* ------------------------- other constrained outputs ------------------------- */

/** One grounding verdict per extracted record. */
export const GROUNDING_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    records: {
      type: "array",
      items: {
        type: "object",
        properties: { i: { type: "number" }, grounded: { type: "boolean" } },
        required: ["i", "grounded"],
        additionalProperties: false,
      },
    },
  },
  required: ["records"],
  additionalProperties: false,
};

/** The note's stated annual rate, or null when the document states none. */
export const RATE_SCHEMA: JsonSchema = {
  type: "object",
  properties: { ratePct: { type: ["number", "null"] } },
  required: ["ratePct"],
  additionalProperties: false,
};
