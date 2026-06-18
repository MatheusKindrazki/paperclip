import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, companies, agents, costEvents, financeEvents, projects } from "@paperclipai/db";
import { costService } from "../services/costs.ts";
import { financeService } from "../services/finance.ts";
import { currentMonthRange } from "../routes/costs.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

function makeDb(overrides: Record<string, unknown> = {}) {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn().mockResolvedValue([]),
  };

  const thenableChain = Object.assign(Promise.resolve([]), selectChain);

  const db: Record<string, unknown> = {
    select: vi.fn().mockReturnValue(thenableChain),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
    ...overrides,
  };
  // Drizzle exposes db.transaction((tx) => ...). Service factories are mocked
  // at the module level, so the tx identity does not matter — only that the
  // callback is invoked. Routes added in PR #5 (PATCH .../budgets) and PR #6
  // (POST atomicity) require this to exist.
  if (!("transaction" in db)) {
    db.transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  }
  return db;
}

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  cancelBudgetScopeWork: vi.fn().mockResolvedValue(undefined),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFetchAllQuotaWindows = vi.hoisted(() => vi.fn());
const mockCostService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn().mockResolvedValue({ spendCents: 0 }),
  byAgent: vi.fn().mockResolvedValue([]),
  byAgentModel: vi.fn().mockResolvedValue([]),
  byProvider: vi.fn().mockResolvedValue([]),
  byBiller: vi.fn().mockResolvedValue([]),
  windowSpend: vi.fn().mockResolvedValue([]),
  byProject: vi.fn().mockResolvedValue([]),
  byIssue: vi.fn().mockResolvedValue([]),
  forIssue: vi.fn().mockResolvedValue({ costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, runCount: 0 }),
}));
const mockFinanceService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn().mockResolvedValue({ debitCents: 0, creditCents: 0, netCents: 0, estimatedDebitCents: 0, eventCount: 0 }),
  byBiller: vi.fn().mockResolvedValue([]),
  byKind: vi.fn().mockResolvedValue([]),
  list: vi.fn().mockResolvedValue([]),
}));
const mockBudgetService = vi.hoisted(() => ({
  overview: vi.fn().mockResolvedValue({
    companyId: "company-1",
    policies: [],
    activeIncidents: [],
    pausedAgentCount: 0,
    pausedProjectCount: 0,
    pendingApprovalCount: 0,
  }),
  upsertPolicy: vi.fn(),
  resolveIncident: vi.fn(),
}));
const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    budgetService: () => mockBudgetService,
    costService: () => mockCostService,
    financeService: () => mockFinanceService,
    companyService: () => mockCompanyService,
    agentService: () => mockAgentService,
    heartbeatService: () => mockHeartbeatService,
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/quota-windows.js", () => ({
    fetchAllQuotaWindows: mockFetchAllQuotaWindows,
  }));
}

async function createApp() {
  const [{ costRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/costs.js")>("../routes/costs.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "board-user", source: "local_implicit" };
    next();
  });
  app.use("/api", costRoutes(makeDb() as any));
  app.use(errorHandler);
  return app;
}

async function createAppWithActor(actor: any) {
  const [{ costRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/costs.js")>("../routes/costs.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", costRoutes(makeDb() as any));
  app.use(errorHandler);
  return app;
}

async function loadCostParsers() {
  const { parseCostDateRange, parseCostLimit, currentMonthRange } = await import("../routes/costs.js");
  return { parseCostDateRange, parseCostLimit, currentMonthRange };
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/quota-windows.js");
  vi.doUnmock("../routes/costs.js");
  vi.doUnmock("../middleware/index.js");
  registerModuleMocks();
  vi.clearAllMocks();
  mockCompanyService.update.mockResolvedValue({
    id: "company-1",
    name: "Paperclip",
    budgetMonthlyCents: 100,
    spentMonthlyCents: 0,
  });
  mockAgentService.getById.mockResolvedValue({
    id: "agent-1",
    companyId: "company-1",
    name: "Budget Agent",
    budgetMonthlyCents: 100,
    spentMonthlyCents: 0,
  });
  mockAgentService.update.mockResolvedValue({
    id: "agent-1",
    companyId: "company-1",
    name: "Budget Agent",
    budgetMonthlyCents: 100,
    spentMonthlyCents: 0,
  });
  mockIssueService.getById.mockResolvedValue({
    id: "issue-1",
    companyId: "company-1",
    title: "Test Issue",
    status: "in_progress",
    identifier: "TST-1",
  });
  mockBudgetService.upsertPolicy.mockResolvedValue(undefined);
});

describe("cost routes", () => {
  it("accepts valid ISO date strings", async () => {
    const { parseCostDateRange } = await loadCostParsers();
    expect(parseCostDateRange({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-31T23:59:59.999Z",
    })).toEqual({
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-31T23:59:59.999Z"),
    });
  });

  it("returns 400 for an invalid 'from' date string", async () => {
    const { parseCostDateRange } = await loadCostParsers();
    expect(() => parseCostDateRange({ from: "not-a-date" })).toThrow(/invalid 'from' date/i);
  });

  it("returns 400 for an invalid 'to' date string", async () => {
    const { parseCostDateRange } = await loadCostParsers();
    expect(() => parseCostDateRange({ to: "banana" })).toThrow(/invalid 'to' date/i);
  });

  it.each(["month", "current_month", "mtd"])(
    "resolves period=%s to the current calendar month (UTC)",
    async (period) => {
      const { parseCostDateRange, currentMonthRange } = await loadCostParsers();
      expect(parseCostDateRange({ period })).toEqual(currentMonthRange());
    },
  );

  it("resolves month=YYYY-MM to that calendar month (UTC)", async () => {
    const { parseCostDateRange } = await loadCostParsers();
    expect(parseCostDateRange({ month: "2026-06" })).toEqual({
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-06-30T23:59:59.999Z"),
    });
  });

  it("lets explicit from/to win over period/month shorthands", async () => {
    const { parseCostDateRange } = await loadCostParsers();
    expect(
      parseCostDateRange({
        from: "2026-01-01T00:00:00.000Z",
        period: "month",
        month: "2026-06",
      }),
    ).toEqual({ from: new Date("2026-01-01T00:00:00.000Z"), to: undefined });
  });

  it("rejects an unknown 'period' value with 400 (no silent fallthrough)", async () => {
    const { parseCostDateRange } = await loadCostParsers();
    expect(() => parseCostDateRange({ period: "year" })).toThrow(/invalid 'period'/i);
  });

  it("rejects a malformed 'month' value with 400", async () => {
    const { parseCostDateRange } = await loadCostParsers();
    expect(() => parseCostDateRange({ month: "2026-6" })).toThrow(/invalid 'month'/i);
    expect(() => parseCostDateRange({ month: "2026-13" })).toThrow(/invalid 'month'/i);
  });

  it("defaults /costs/summary to the current month (not lifetime) when no range is given", async () => {
    const { currentMonthRange } = await loadCostParsers();
    const app = await createApp();
    const res = await request(app).get("/api/companies/company-1/costs/summary");
    expect(res.status).toBe(200);
    // Regression for MOKA-4620: the route must hand the service a monthly
    // window so lifetime spend is never divided by the monthly budget.
    expect(mockCostService.summary).toHaveBeenCalledWith("company-1", currentMonthRange());
  });

  it("returns 400 from /costs/summary for an unknown period instead of silently using lifetime", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/summary")
      .query({ period: "all_time" });
    expect(res.status).toBe(400);
    expect(mockCostService.summary).not.toHaveBeenCalled();
  });

  it("returns finance summary rows for valid requests", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/finance-summary")
      .query({ from: "2026-02-01T00:00:00.000Z", to: "2026-02-28T23:59:59.999Z" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      debitCents: 0,
      creditCents: 0,
      netCents: 0,
      estimatedDebitCents: 0,
      eventCount: 0,
    });
  });

  it("returns 400 for invalid finance event list limits", async () => {
    const { parseCostLimit } = await loadCostParsers();
    expect(() => parseCostLimit({ limit: "0" })).toThrow(/invalid 'limit'/i);
  });

  it("accepts valid finance event list limits", async () => {
    const { parseCostLimit } = await loadCostParsers();
    expect(parseCostLimit({ limit: "25" })).toBe(25);
  });

  it("rejects company budget updates for board users outside the company", async () => {
    const app = await createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app)
      .patch("/api/companies/company-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("rejects agent budget updates for board users outside the agent company", async () => {
    const app = await createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects agent budget updates from the target agent without changing the budget policy", async () => {
    const app = await createAppWithActor({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Board access required" });
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects agent budget updates from another same-company agent without changing the budget policy", async () => {
    const app = await createAppWithActor({
      type: "agent",
      agentId: "agent-2",
      companyId: "company-1",
      runId: "run-2",
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Board access required" });
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("allows authorized board users to update an agent budget and budget policy", async () => {
    mockAgentService.update.mockResolvedValueOnce({
      id: "agent-1",
      companyId: "company-1",
      name: "Budget Agent",
      budgetMonthlyCents: 2500,
      spentMonthlyCents: 0,
    });
    const app = await createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith("agent-1", { budgetMonthlyCents: 2500 });
    expect(mockBudgetService.upsertPolicy).toHaveBeenCalledWith(
      "company-1",
      {
        scopeType: "agent",
        scopeId: "agent-1",
        amount: 2500,
        windowKind: "calendar_month_utc",
      },
      "board-user",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "user",
        actorId: "board-user",
        agentId: null,
        action: "agent.budget_updated",
        entityType: "agent",
        entityId: "agent-1",
        details: { budgetMonthlyCents: 2500 },
      }),
    );
  });

  it("rolls back agent budget update when upsertPolicy throws (atomicity)", async () => {
    mockAgentService.update.mockResolvedValueOnce({
      id: "agent-1",
      companyId: "company-1",
      name: "Budget Agent",
      budgetMonthlyCents: 2500,
      spentMonthlyCents: 0,
    });
    mockBudgetService.upsertPolicy.mockRejectedValueOnce(new Error("DB deadlock"));

    const app = await createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(500);
    expect(mockAgentService.update).toHaveBeenCalledTimes(1);
    expect(mockBudgetService.upsertPolicy).toHaveBeenCalledTimes(1);
    // logActivity must NOT run when the transaction rejected
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rolls back company budget update when upsertPolicy throws (atomicity)", async () => {
    mockCompanyService.update.mockResolvedValueOnce({
      id: "company-1",
      name: "Paperclip",
      budgetMonthlyCents: 250000,
      spentMonthlyCents: 0,
    });
    mockBudgetService.upsertPolicy.mockRejectedValueOnce(new Error("DB deadlock"));

    const app = await createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .patch("/api/companies/company-1/budgets")
      .send({ budgetMonthlyCents: 250000 });

    expect(res.status).toBe(500);
    expect(mockCompanyService.update).toHaveBeenCalledTimes(1);
    expect(mockBudgetService.upsertPolicy).toHaveBeenCalledTimes(1);
    // logActivity must NOT run when the transaction rejected
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("returns token metrics for a valid issue", async () => {
    mockIssueService.getById.mockResolvedValueOnce({
      id: "issue-1",
      companyId: "company-1",
      title: "Test Issue",
      status: "in_progress",
    });
    mockCostService.forIssue.mockResolvedValueOnce({
      costCents: 1500,
      inputTokens: 1000,
      cachedInputTokens: 200,
      outputTokens: 500,
      runCount: 3,
    });

    const app = await createApp();
    const res = await request(app).get("/api/issues/issue-1/tokens");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      costCents: 1500,
      runCount: 3,
    });
  });

  it("returns 404 for non-existent issue", async () => {
    mockIssueService.getById.mockResolvedValueOnce(null);

    const app = await createApp();
    const res = await request(app).get("/api/issues/missing-issue/tokens");

    expect(res.status).toBe(404);
    expect(mockCostService.forIssue).not.toHaveBeenCalled();
  });

  it("returns costs grouped by issue", async () => {
    mockCostService.byIssue.mockResolvedValueOnce([
      {
        issueId: "issue-1",
        issueTitle: "Feature A",
        costCents: 2000,
        runCount: 5,
      },
    ]);

    const app = await createApp();
    const res = await request(app).get("/api/companies/company-1/costs/by-issue");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].issueTitle).toBe("Feature A");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cost and finance aggregate overflow handling", () => {
  let db!: ReturnType<typeof createDb>;
  let costs!: ReturnType<typeof costService>;
  let finance!: ReturnType<typeof financeService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-costs-service-");
    db = createDb(tempDb.connectionString);
    costs = costService(db);
    finance = financeService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("aggregates cost event sums above int32 without raising Postgres integer overflow", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Overflow Project",
      status: "active",
    });

    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        projectId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 2_000_000_000,
        cachedInputTokens: 0,
        outputTokens: 200_000_000,
        costCents: 2_000_000_000,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        companyId,
        agentId,
        projectId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 2_000_000_000,
        cachedInputTokens: 10,
        outputTokens: 200_000_000,
        costCents: 2_000_000_000,
        occurredAt: new Date("2026-04-11T00:00:00.000Z"),
      },
    ]);

    const range = {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    };

    const [byAgentRow] = await costs.byAgent(companyId, range);
    const [byProjectRow] = await costs.byProject(companyId, range);
    const [byAgentModelRow] = await costs.byAgentModel(companyId, range);

    expect(byAgentRow?.costCents).toBe(4_000_000_000);
    expect(byAgentRow?.inputTokens).toBe(4_000_000_000);
    expect(byProjectRow?.costCents).toBe(4_000_000_000);
    expect(byAgentModelRow?.costCents).toBe(4_000_000_000);
  });

  it("scopes summary utilization to the current month so lifetime spend is not divided by the monthly budget (MOKA-4620)", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    // Monthly budget of $40.00. Prior-month spend ($60.00) dwarfs the budget;
    // current-month spend ($26.00) is comfortably within it.
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      budgetMonthlyCents: 4000,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const monthRange = currentMonthRange();
    const priorMonth = new Date(monthRange.from.getTime() - 5 * 24 * 60 * 60 * 1000);
    const currentMonth = new Date(monthRange.from.getTime() + 60 * 60 * 1000);

    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costCents: 6000,
        occurredAt: priorMonth,
      },
      {
        companyId,
        agentId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costCents: 2600,
        occurredAt: currentMonth,
      },
    ]);

    // Lifetime (no range) sums both months and produces a meaningless
    // over-budget reading — this is the bug the default range guards against.
    const lifetime = await costs.summary(companyId);
    expect(lifetime.spendCents).toBe(8600);
    expect(lifetime.utilizationPercent).toBeGreaterThan(100);

    // The route now passes the current-month window: utilization reflects MTD
    // ($26.00 / $40.00 = 65%), never lifetime spend over a monthly budget.
    const monthly = await costs.summary(companyId, monthRange);
    expect(monthly.spendCents).toBe(2600);
    expect(monthly.budgetCents).toBe(4000);
    expect(monthly.utilizationPercent).toBe(65);
  });

  it("aggregates finance event sums above int32 without raising Postgres integer overflow", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(financeEvents).values([
      {
        companyId,
        biller: "openai",
        eventKind: "invoice",
        amountCents: 2_000_000_000,
        currency: "USD",
        direction: "debit",
        estimated: false,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        companyId,
        biller: "openai",
        eventKind: "invoice",
        amountCents: 2_000_000_000,
        currency: "USD",
        direction: "debit",
        estimated: true,
        occurredAt: new Date("2026-04-11T00:00:00.000Z"),
      },
    ]);

    const range = {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    };

    const summary = await finance.summary(companyId, range);
    const [byKindRow] = await finance.byKind(companyId, range);

    expect(summary.debitCents).toBe(4_000_000_000);
    expect(summary.estimatedDebitCents).toBe(2_000_000_000);
    expect(byKindRow?.debitCents).toBe(4_000_000_000);
    expect(byKindRow?.netCents).toBe(4_000_000_000);
  });
});
