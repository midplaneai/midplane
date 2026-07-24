// Unit coverage for lib/plan.ts — the plan/caps resolution layer.
//
// resolvePlan() resolves (via currentCustomer) in order: plan_override (the
// manual lever, which BEATS the subscription) → the subscription-backed
// customers.plan written by the Stripe webhook → `free`. hasEntitlement()
// returns false (ee not wired). We mock currentCustomer to stage both columns.
// CAPS, the pre-flight block, and the typed limit error are pure and asserted
// directly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Customer } from "@midplane-cloud/db";

import {
  CAPS,
  DatabaseLimitError,
  MAX_DATABASES_PER_PROJECT,
  PLAN_PRICING,
  PlanLimitError,
  SELF_HOST_CAPS,
  UPGRADE_URL,
  databaseAddBlock,
  maxDatabasesPerProject,
  planLimitBody,
  projectAddBlock,
  projectCreateBlock,
  projectQuota,
  hasEntitlement,
  resolvePlan,
  resolvePlanFor,
} from "../src/lib/plan.ts";

// currentCustomer is reassigned per-test through a getter so each test can
// stage a different plan_override / subscription plan (or a null customer).
let currentCustomerMock: () => Promise<Customer | null>;

vi.mock("@/lib/customer", () => ({
  get currentCustomer() {
    return currentCustomerMock;
  },
}));

function customerWith(
  planOverride: Customer["planOverride"],
  plan: Customer["plan"] = "free",
): Customer {
  return {
    id: "01HCUSTOMER0000000000000000",
    orgId: "org_1",
    email: "u@e.test",
    region: "eu",
    planOverride,
    plan,
    ownerEmail: null,
    createdAt: new Date(),
  };
}

beforeEach(() => {
  currentCustomerMock = async () => customerWith(null);
});

describe("CAPS", () => {
  it("encodes the PRICING.md tiers exactly", () => {
    expect(CAPS.free).toEqual({
      projects: 1,
      tokens: 5,
      auditRetentionDays: 7,
      sso: false,
      seats: 1,
    });
    expect(CAPS.pro).toEqual({
      projects: 10,
      tokens: 50,
      auditRetentionDays: 30,
      sso: false,
      seats: 10,
    });
    expect(CAPS.team).toEqual({
      projects: Infinity,
      tokens: Infinity,
      auditRetentionDays: 90,
      sso: true,
      seats: Infinity,
    });
  });

  it("models unlimited tiers as Infinity so `count >= cap` is never true", () => {
    expect(999_999 >= CAPS.team.projects).toBe(false);
    expect(999_999 >= CAPS.team.tokens).toBe(false);
  });
});

describe("PLAN_PRICING", () => {
  it("matches the PRICING.md display prices ($0 / $49 / $399)", () => {
    expect(PLAN_PRICING.free).toEqual({ amount: "$0", period: "" });
    expect(PLAN_PRICING.pro).toEqual({ amount: "$49", period: "/mo" });
    expect(PLAN_PRICING.team).toEqual({ amount: "$399", period: "/mo" });
  });

  it("covers every plan tier in CAPS (no missing/extra keys)", () => {
    expect(Object.keys(PLAN_PRICING).sort()).toEqual(Object.keys(CAPS).sort());
  });
});

describe("resolvePlan", () => {
  it("resolves free when plan_override is null and plan is 'free'", async () => {
    currentCustomerMock = async () => customerWith(null);
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("free");
    expect(caps).toEqual(CAPS.free);
  });

  it("resolves free when there is no customer", async () => {
    currentCustomerMock = async () => null;
    const { plan } = await resolvePlan();
    expect(plan).toBe("free");
  });

  it("resolves the subscription-backed plan when no override (plan = 'pro')", async () => {
    currentCustomerMock = async () => customerWith(null, "pro");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("pro");
    expect(caps).toEqual(CAPS.pro);
  });

  it("resolves the subscription-backed plan when no override (plan = 'team')", async () => {
    currentCustomerMock = async () => customerWith(null, "team");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("team");
    expect(caps).toEqual(CAPS.team);
  });

  it("plan_override BEATS the subscription plan (override 'team' over plan 'free')", async () => {
    currentCustomerMock = async () => customerWith("team", "free");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("team");
    expect(caps).toEqual(CAPS.team);
  });

  it("plan_override can DOWNGRADE below the subscription (override 'free' over plan 'team')", async () => {
    // Support lever: cap a paying org for abuse/refund without touching Stripe.
    currentCustomerMock = async () => customerWith("free", "team");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("free");
    expect(caps).toEqual(CAPS.free);
  });

  it("forces team caps when plan_override is 'team' (no subscription needed)", async () => {
    currentCustomerMock = async () => customerWith("team");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("team");
    expect(caps).toEqual(CAPS.team);
  });

  it("forces pro caps when plan_override is 'pro'", async () => {
    currentCustomerMock = async () => customerWith("pro");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("pro");
    expect(caps).toEqual(CAPS.pro);
  });

  it("can force a LOWER tier ('free') to exercise the capped UI", async () => {
    currentCustomerMock = async () => customerWith("free");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("free");
    expect(caps).toEqual(CAPS.free);
  });
});

describe("resolvePlan in self-host (MIDPLANE_SELF_HOST=1)", () => {
  const prev = process.env.MIDPLANE_SELF_HOST;
  beforeEach(() => {
    process.env.MIDPLANE_SELF_HOST = "1";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.MIDPLANE_SELF_HOST;
    else process.env.MIDPLANE_SELF_HOST = prev;
  });

  it("returns uncapped caps and never reads a customer", async () => {
    // Self-host resolves BEFORE the customer.ts import — if it didn't, this
    // mock would throw and fail the test, proving the early return.
    currentCustomerMock = async () => {
      throw new Error("resolvePlan must not read a customer in self-host");
    };
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("team");
    expect(caps).toEqual(SELF_HOST_CAPS);
    // Uncapped: count >= cap is never true; Infinity retention = no clamp.
    expect(caps.projects).toBe(Infinity);
    expect(caps.tokens).toBe(Infinity);
    expect(caps.auditRetentionDays).toBe(Infinity);
    expect(caps.seats).toBe(Infinity);
    // sso stays gated (ee, license-deferred) even uncapped.
    expect(caps.sso).toBe(false);
  });
});

describe("hasEntitlement", () => {
  it("returns false for every feature (no billing / ee wired yet)", async () => {
    expect(await hasEntitlement("sso")).toBe(false);
  });
});

describe("projectCreateBlock", () => {
  it("returns null when both caps have room", () => {
    expect(
      projectCreateBlock({ projects: 3, tokens: 4 }, CAPS.pro),
    ).toBeNull();
  });

  it("flags the project cap first when it's reached", () => {
    expect(
      projectCreateBlock({ projects: 1, tokens: 1 }, CAPS.free),
    ).toEqual({ resource: "projects", limit: 1 });
  });

  it("flags the token cap when projects have room but tokens don't", () => {
    // Pro: 10 projects / 50 tokens. Manually minting extra tokens can
    // exhaust the token slot a new project's default would need before
    // the project cap is hit.
    expect(
      projectCreateBlock({ projects: 4, tokens: 50 }, CAPS.pro),
    ).toEqual({ resource: "tokens", limit: 50 });
  });

  it("never blocks on unlimited (Infinity) caps", () => {
    expect(
      projectCreateBlock({ projects: 999_999, tokens: 999_999 }, CAPS.team),
    ).toBeNull();
  });
});

describe("databaseAddBlock", () => {
  // The ceiling is a FIXED structural bound, identical on every plan (no caps
  // arg) — see maxDatabasesPerProject.
  it("returns null while the project has room (below the ceiling)", () => {
    expect(
      databaseAddBlock({ databases: MAX_DATABASES_PER_PROJECT - 1 }),
    ).toBeNull();
  });

  it("flags the ceiling when the project is full", () => {
    expect(databaseAddBlock({ databases: MAX_DATABASES_PER_PROJECT })).toEqual({
      limit: MAX_DATABASES_PER_PROJECT,
    });
  });

  it("still blocks when usage already exceeds the ceiling", () => {
    expect(
      databaseAddBlock({ databases: MAX_DATABASES_PER_PROJECT + 5 }),
    ).toEqual({ limit: MAX_DATABASES_PER_PROJECT });
  });

  it("never blocks in self-host (uncapped — Infinity)", () => {
    const prev = process.env.MIDPLANE_SELF_HOST;
    process.env.MIDPLANE_SELF_HOST = "1";
    try {
      expect(databaseAddBlock({ databases: 999_999 })).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.MIDPLANE_SELF_HOST;
      else process.env.MIDPLANE_SELF_HOST = prev;
    }
  });
});

describe("projectAddBlock", () => {
  it("returns null while the org has room (Pro: 3 of 10)", () => {
    expect(projectAddBlock({ projects: 3 }, CAPS.pro)).toBeNull();
  });

  it("flags the cap when the org is full (Free: 1 of 1)", () => {
    expect(projectAddBlock({ projects: 1 }, CAPS.free)).toEqual({ limit: 1 });
  });

  it("never blocks on unlimited (Infinity) caps", () => {
    expect(projectAddBlock({ projects: 999_999 }, CAPS.team)).toBeNull();
    expect(projectAddBlock({ projects: 999_999 }, SELF_HOST_CAPS)).toBeNull();
  });
});

describe("projectQuota", () => {
  it("has room: not at cap, formats the usage line, passes the limit through", () => {
    expect(
      projectQuota({
        billableProjects: 3,
        hasEmpty: false,
        caps: CAPS.pro,
        plan: "pro",
      }),
    ).toEqual({
      atCap: false,
      quotaLine: "pro plan · 3/10 projects",
      projectLimit: 10,
    });
  });

  it("Free at 1/1 with no empty project is at cap", () => {
    const q = projectQuota({
      billableProjects: 1,
      hasEmpty: false,
      caps: CAPS.free,
      plan: "free",
    });
    expect(q.atCap).toBe(true);
    expect(q.quotaLine).toBe("free plan · 1/1 projects");
  });

  it("a reusable empty project clears the cap even at the limit", () => {
    // createProject attaches the first DB to the empty project without
    // consuming a slot, so "New project" must stay available.
    expect(
      projectQuota({
        billableProjects: 1,
        hasEmpty: true,
        caps: CAPS.free,
        plan: "free",
      }).atCap,
    ).toBe(false);
  });

  it("fresh Free (0/1) is not at cap", () => {
    expect(
      projectQuota({
        billableProjects: 0,
        hasEmpty: false,
        caps: CAPS.free,
        plan: "free",
      }),
    ).toEqual({
      atCap: false,
      quotaLine: "free plan · 0/1 projects",
      projectLimit: 1,
    });
  });

  it("unlimited (Team) is never at cap and shows no quota line", () => {
    expect(
      projectQuota({
        billableProjects: 5,
        hasEmpty: false,
        caps: CAPS.team,
        plan: "team",
      }),
    ).toEqual({ atCap: false, quotaLine: null, projectLimit: Infinity });
  });
});

describe("resolvePlanFor (sync twin — customer already in hand)", () => {
  it("defaults to free with no customer / no plan columns", () => {
    expect(resolvePlanFor(null)).toEqual({ plan: "free", caps: CAPS.free });
    expect(resolvePlanFor({})).toEqual({ plan: "free", caps: CAPS.free });
  });

  it("resolves the subscription-backed plan", () => {
    expect(resolvePlanFor(customerWith(null, "pro"))).toEqual({
      plan: "pro",
      caps: CAPS.pro,
    });
  });

  it("plan_override BEATS the subscription in either direction", () => {
    expect(resolvePlanFor(customerWith("team", "free")).plan).toBe("team");
    expect(resolvePlanFor(customerWith("free", "team")).plan).toBe("free");
  });

  it("returns uncapped caps in self-host, ignoring the customer row", () => {
    const prev = process.env.MIDPLANE_SELF_HOST;
    process.env.MIDPLANE_SELF_HOST = "1";
    try {
      expect(resolvePlanFor(customerWith(null, "free"))).toEqual({
        plan: "team",
        caps: SELF_HOST_CAPS,
      });
    } finally {
      if (prev === undefined) delete process.env.MIDPLANE_SELF_HOST;
      else process.env.MIDPLANE_SELF_HOST = prev;
    }
  });
});

describe("PlanLimitError", () => {
  it("carries resource, limit, and plan for call-site translation", () => {
    const err = new PlanLimitError("projects", 1, "free");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PlanLimitError");
    expect(err.resource).toBe("projects");
    expect(err.limit).toBe(1);
    expect(err.plan).toBe("free");
  });
});

describe("planLimitBody", () => {
  it("serializes a plan-cap error to the shared 402 shape", () => {
    // planLimitBody covers only genuine plan resources (projects / tokens);
    // the per-project database ceiling is NOT one of them (it's plan-
    // independent and never a 402 — see DatabaseLimitError below).
    const body = planLimitBody(new PlanLimitError("projects", 1, "free"));
    expect(body).toEqual({
      error: "plan_limit",
      resource: "projects",
      limit: 1,
      plan: "free",
      upgradeUrl: UPGRADE_URL,
    });
  });
});

describe("DatabaseLimitError + maxDatabasesPerProject", () => {
  it("carries only the (plan-independent) limit — no plan / resource", () => {
    const err = new DatabaseLimitError(MAX_DATABASES_PER_PROJECT);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DatabaseLimitError");
    expect(err.limit).toBe(MAX_DATABASES_PER_PROJECT);
  });

  it("applies the fixed ceiling on cloud, uncaps it in self-host", () => {
    expect(maxDatabasesPerProject()).toBe(MAX_DATABASES_PER_PROJECT);
    const prev = process.env.MIDPLANE_SELF_HOST;
    process.env.MIDPLANE_SELF_HOST = "1";
    try {
      expect(maxDatabasesPerProject()).toBe(Infinity);
    } finally {
      if (prev === undefined) delete process.env.MIDPLANE_SELF_HOST;
      else process.env.MIDPLANE_SELF_HOST = prev;
    }
  });
});
