import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createCostEventSchema,
  createFinanceEventSchema,
  resolveBudgetIncidentSchema,
  updateBudgetSchema,
  upsertBudgetPolicySchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  budgetService,
  costService,
  financeService,
  companyService,
  agentService,
  heartbeatService,
  issueService,
  logActivity,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { fetchAllQuotaWindows } from "../services/quota-windows.js";
import { badRequest } from "../errors.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

// Aliases that select the current calendar month (UTC). The company/agent
// budgets are monthly, so summary-style endpoints must default to this window
// rather than lifetime spend (MOKA-4620).
const CURRENT_MONTH_PERIOD_ALIASES = new Set(["month", "current_month", "mtd"]);

function startOfUtcMonth(year: number, monthIndex: number) {
  return new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
}

// Calendar-month range with an inclusive end (last ms of the month) so it
// composes with the gte(from)+lte(to) filters used by the cost queries.
export function currentMonthRange(now = new Date()): { from: Date; to: Date } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    from: startOfUtcMonth(year, month),
    to: new Date(startOfUtcMonth(year, month + 1).getTime() - 1),
  };
}

function singleParam(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw == null || raw === "" ? undefined : String(raw);
}

export function parseCostDateRange(query: Record<string, unknown>) {
  const fromRaw = query.from as string | undefined;
  const toRaw = query.to as string | undefined;
  const from = fromRaw ? new Date(fromRaw) : undefined;
  const to = toRaw ? new Date(toRaw) : undefined;
  if (from && isNaN(from.getTime())) throw badRequest("invalid 'from' date");
  if (to && isNaN(to.getTime())) throw badRequest("invalid 'to' date");
  // Explicit from/to wins over the period/month shorthands.
  if (from || to) return { from, to };

  const month = singleParam(query.month);
  if (month) {
    const match = /^(\d{4})-(\d{2})$/.exec(month);
    if (!match) throw badRequest("invalid 'month' value, expected YYYY-MM");
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    if (monthIndex < 0 || monthIndex > 11) {
      throw badRequest("invalid 'month' value, month must be 01-12");
    }
    return {
      from: startOfUtcMonth(year, monthIndex),
      to: new Date(startOfUtcMonth(year, monthIndex + 1).getTime() - 1),
    };
  }

  const period = singleParam(query.period);
  if (period) {
    if (!CURRENT_MONTH_PERIOD_ALIASES.has(period)) {
      throw badRequest(
        `invalid 'period' value '${period}', supported: ${[...CURRENT_MONTH_PERIOD_ALIASES].join(", ")}`,
      );
    }
    return currentMonthRange();
  }

  return undefined;
}

export function parseCostLimit(query: Record<string, unknown>) {
  const raw = Array.isArray(query.limit) ? query.limit[0] : query.limit;
  if (raw == null || raw === "") return 100;
  const limit = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(limit) || limit <= 0 || limit > 500) {
    throw badRequest("invalid 'limit' value");
  }
  return limit;
}

export function costRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const budgetHooks = {
    cancelWorkForScope: heartbeat.cancelBudgetScopeWork,
  };
  const costs = costService(db, budgetHooks);
  const finance = financeService(db);
  const budgets = budgetService(db, budgetHooks);
  const companies = companyService(db);
  const agents = agentService(db);
  const issues = issueService(db);

  router.post("/companies/:companyId/cost-events", validate(createCostEventSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only report its own costs" });
      return;
    }

    const event = await costs.createEvent(companyId, {
      ...req.body,
      occurredAt: new Date(req.body.occurredAt),
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "cost.reported",
      entityType: "cost_event",
      entityId: event.id,
      details: { costCents: event.costCents, model: event.model },
    });

    res.status(201).json(event);
  });

  router.post("/companies/:companyId/finance-events", validate(createFinanceEventSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const event = await finance.createEvent(companyId, {
      ...req.body,
      occurredAt: new Date(req.body.occurredAt),
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "finance_event.reported",
      entityType: "finance_event",
      entityId: event.id,
      details: {
        amountCents: event.amountCents,
        biller: event.biller,
        eventKind: event.eventKind,
        direction: event.direction,
      },
    });

    res.status(201).json(event);
  });

  router.get("/companies/:companyId/costs/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    // The budget compared against is monthly, so default to the current
    // calendar month instead of lifetime spend (MOKA-4620).
    const range = parseCostDateRange(req.query) ?? currentMonthRange();
    const summary = await costs.summary(companyId, range);
    res.json(summary);
  });

  router.get("/companies/:companyId/costs/by-agent", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseCostDateRange(req.query) ?? currentMonthRange();
    const rows = await costs.byAgent(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-agent-model", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseCostDateRange(req.query);
    const rows = await costs.byAgentModel(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-provider", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseCostDateRange(req.query);
    const rows = await costs.byProvider(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-biller", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseCostDateRange(req.query);
    const rows = await costs.byBiller(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/finance-summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseCostDateRange(req.query);
    const summary = await finance.summary(companyId, range);
    res.json(summary);
  });

  router.get("/companies/:companyId/costs/finance-by-biller", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseCostDateRange(req.query);
    const rows = await finance.byBiller(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/finance-by-kind", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseCostDateRange(req.query);
    const rows = await finance.byKind(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/finance-events", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseCostDateRange(req.query);
    const limit = parseCostLimit(req.query);
    const rows = await finance.list(companyId, range, limit);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/window-spend", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await costs.windowSpend(companyId);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/quota-windows", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    // validate companyId resolves to a real company so the "__none__" sentinel
    // and any forged ids are rejected before we touch provider credentials
    const company = await companies.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const results = await fetchAllQuotaWindows();
    res.json(results);
  });

  router.get("/companies/:companyId/budgets/overview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const overview = await budgets.overview(companyId);
    res.json(overview);
  });

  router.post(
    "/companies/:companyId/budgets/policies",
    validate(upsertBudgetPolicySchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const summary = await budgets.upsertPolicy(companyId, req.body, req.actor.userId ?? "board");
      res.json(summary);
    },
  );

  router.post(
    "/companies/:companyId/budget-incidents/:incidentId/resolve",
    validate(resolveBudgetIncidentSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const incidentId = req.params.incidentId as string;
      assertCompanyAccess(req, companyId);
      const incident = await budgets.resolveIncident(companyId, incidentId, req.body, req.actor.userId ?? "board");
      res.json(incident);
    },
  );

  router.get("/companies/:companyId/costs/by-project", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseCostDateRange(req.query);
    const rows = await costs.byProject(companyId, range);
    res.json(rows);
  });

  router.get("/issues/:id/tokens", async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await issues.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const row = await costs.forIssue(issue.companyId, issue.id);
    res.json(row);
  });

  router.get("/companies/:companyId/costs/by-issue", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseCostDateRange(req.query);
    const rows = await costs.byIssue(companyId, range);
    res.json(rows);
  });

  router.patch("/companies/:companyId/budgets", validate(updateBudgetSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await db.transaction(async (tx) => {
      const updated = await companyService(tx as unknown as Db).update(companyId, { budgetMonthlyCents: req.body.budgetMonthlyCents });
      if (!updated) return null;
      await budgetService(tx as unknown as Db, budgetHooks).upsertPolicy(
        companyId,
        {
          scopeType: "company",
          scopeId: companyId,
          amount: req.body.budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        req.actor.userId ?? "board",
      );
      return updated;
    });
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.budget_updated",
      entityType: "company",
      entityId: companyId,
      details: { budgetMonthlyCents: req.body.budgetMonthlyCents },
    });

    res.json(company);
  });

  router.patch("/agents/:agentId/budgets", validate(updateBudgetSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const agent = await agents.getById(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    assertCompanyAccess(req, agent.companyId);
    assertBoard(req);

    const updated = await db.transaction(async (tx) => {
      const agentUpdated = await agentService(tx as unknown as Db).update(agentId, { budgetMonthlyCents: req.body.budgetMonthlyCents });
      if (!agentUpdated) return null;
      await budgetService(tx as unknown as Db, budgetHooks).upsertPolicy(
        agentUpdated.companyId,
        {
          scopeType: "agent",
          scopeId: agentUpdated.id,
          amount: req.body.budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      );
      return agentUpdated;
    });
    if (!updated) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "agent.budget_updated",
      entityType: "agent",
      entityId: updated.id,
      details: { budgetMonthlyCents: updated.budgetMonthlyCents },
    });

    res.json(updated);
  });

  return router;
}
