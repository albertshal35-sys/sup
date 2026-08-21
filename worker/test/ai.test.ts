import { describe, expect, it } from "vitest";
import { listSchema, objectSchema, shapeHint, RECORD_SHAPES, RATE_SCHEMA, type Shape } from "../src/schema";
import { parseJsonArray, modelFor } from "../src/ai";

/** Env stub whose app_settings table returns whatever is seeded. */
const envWith = (settings: Record<string, string>, aiModel?: string) =>
  ({
    AI_MODEL: aiModel,
    DB: {
      prepare: () => ({
        bind: (key: string) => ({ first: async () => (settings[key] ? { value: settings[key] } : null) }),
      }),
    },
  }) as never;

describe("record shapes", () => {
  it("generates a JSON Schema and a prompt hint from one source", () => {
    const shape: Shape = {
      docNumber: { t: "string" },
      apn: { t: "string", nullable: true },
      price: { t: "number" },
      isCash: { t: "boolean" },
      recordedAt: { t: "string", hint: "YYYY-MM-DD" },
      lienType: { t: "string", nullable: true, enum: ["mechanics", "tax"] },
    };

    expect(shapeHint(shape)).toBe(
      '{"docNumber":string,"apn":string|null,"price":number,"isCash":boolean,' +
        '"recordedAt":"YYYY-MM-DD","lienType":"mechanics"|"tax"|null}',
    );

    const schema = objectSchema(shape);
    expect(schema.properties!.docNumber).toEqual({ type: "string" });
    expect(schema.properties!.apn).toEqual({ type: ["string", "null"] });
    expect(schema.properties!.price).toEqual({ type: "number" });
    // Nullable enums must admit null, or a constrained model cannot express "absent".
    expect(schema.properties!.lienType).toEqual({ type: ["string", "null"], enum: ["mechanics", "tax", null] });
    // Every field required — nullability lives in the type, so a model can't
    // quietly drop a key and leave the integrity gate to notice later.
    expect(schema.required).toEqual(Object.keys(shape));
    expect(schema.additionalProperties).toBe(false);
  });

  it("wraps lists in an object root", () => {
    // Object roots are what every JSON-mode implementation supports; the
    // parser accepts a bare array anyway, so this costs nothing.
    const schema = listSchema(RECORD_SHAPES.county_deeds);
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["records"]);
    expect((schema.properties!.records as { type: string }).type).toBe("array");
  });

  it("covers every connector the extractor can be asked for", () => {
    for (const id of ["county_deeds", "county_loans", "permits", "liens", "satisfactions", "ucc_filings", "corp_registry"]) {
      expect(RECORD_SHAPES[id], id).toBeDefined();
      expect(Object.keys(RECORD_SHAPES[id]).length).toBeGreaterThan(3);
    }
  });

  it("keeps the enum values the upsert gates actually accept", () => {
    // Drift here is silent: the model returns a value the gate rejects and
    // the record is quarantined with no obvious cause.
    const lienType = RECORD_SHAPES.liens.lienType as { enum: readonly string[] };
    expect(lienType.enum).toContain("mechanics");
    expect(lienType.enum).toContain("lis_pendens");
    const lenderType = RECORD_SHAPES.county_loans.lenderType as { enum: readonly string[] };
    expect(lenderType.enum).toEqual(["private", "hard_money", "bank"]);
  });

  it("constrains the rate reply to a nullable number", () => {
    expect(RATE_SCHEMA.properties!.ratePct).toEqual({ type: ["number", "null"] });
  });
});

describe("parsing model replies", () => {
  const records = [{ docNumber: "A1" }, { docNumber: "A2" }];

  it("reads the schema envelope", () => {
    expect(parseJsonArray(JSON.stringify({ records }))).toEqual(records);
  });

  it("still reads a bare array, as unconstrained models emit", () => {
    expect(parseJsonArray(JSON.stringify(records))).toEqual(records);
  });

  it("reads through code fences either way", () => {
    expect(parseJsonArray("```json\n" + JSON.stringify({ records }) + "\n```")).toEqual(records);
    expect(parseJsonArray("```\n" + JSON.stringify(records) + "\n```")).toEqual(records);
  });

  it("tolerates prose around the JSON", () => {
    expect(parseJsonArray(`Here you go:\n${JSON.stringify({ records })}\nHope that helps!`)).toEqual(records);
  });

  it("returns empty rather than throwing on junk", () => {
    // A garbled reply means the source produced nothing — not a pipeline error.
    for (const junk of ["", "no json here", "{broken", "[1,2", "null"]) {
      expect(parseJsonArray(junk)).toEqual([]);
    }
  });

  it("does not guess when an object holds several arrays", () => {
    expect(parseJsonArray(JSON.stringify({ records, errors: ["x"] }))).toEqual([]);
  });
});

describe("model selection", () => {
  it("defaults extraction to the cheap tier and prose to the strong one", async () => {
    const env = envWith({});
    expect(await modelFor(env, "extract")).toBe("@cf/google/gemma-4-26b-a4b-it");
    expect(await modelFor(env, "prose")).toBe("@cf/moonshotai/kimi-k2.6");
  });

  it("lets each role be overridden independently", async () => {
    const env = envWith({ ai_model_extract: "@cf/zai-org/glm-4.7-flash" });
    expect(await modelFor(env, "extract")).toBe("@cf/zai-org/glm-4.7-flash");
    expect(await modelFor(env, "prose")).toBe("@cf/moonshotai/kimi-k2.6"); // untouched
  });

  it("honours an existing both-roles pin so upgrades do not move a deployment", async () => {
    const env = envWith({ ai_model: "@cf/moonshotai/kimi-k2.6" });
    expect(await modelFor(env, "extract")).toBe("@cf/moonshotai/kimi-k2.6");
    expect(await modelFor(env, "prose")).toBe("@cf/moonshotai/kimi-k2.6");
  });

  it("prefers the role setting over the shared pin and the env var", async () => {
    const env = envWith({ ai_model: "@cf/shared/pin", ai_model_extract: "@cf/role/specific" }, "@cf/env/var");
    expect(await modelFor(env, "extract")).toBe("@cf/role/specific");
    expect(await modelFor(env, "prose")).toBe("@cf/shared/pin");
  });

  it("falls back to the env var when no setting is stored", async () => {
    const env = envWith({}, "@cf/env/var");
    expect(await modelFor(env, "extract")).toBe("@cf/env/var");
  });
});
