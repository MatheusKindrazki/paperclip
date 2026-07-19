import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { analyticsService } from "../services/analytics.js";
import { parseCostDateRange } from "./costs.js";
import { assertCompanyAccess } from "./authz.js";

export function analyticsRoutes(db: Db) {
  const router = Router();
  const analytics = analyticsService(db);

  /**
   * GET /companies/:companyId/analytics/agents-status
   * Bulk agent status: all agents with status, active issues, MTD runs & spend.
   */
  router.get("/companies/:companyId/analytics/agents-status", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await analytics.bulkAgentStatus(companyId);
    res.json(rows);
  });

  /**
   * GET /companies/:companyId/analytics/validation-ledger
   * Per-project validation summary: completed issues, cycle time, cost, tokens.
   * Supports ?from=ISO&to=ISO date range.
   */
  router.get("/companies/:companyId/analytics/validation-ledger", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseCostDateRange(req.query);
    const rows = await analytics.validationLedger(companyId, range);
    res.json(rows);
  });

  /**
   * GET /companies/:companyId/analytics/token-efficiency
   * Per-agent token efficiency: tokens/cost per issue and per run.
   * Supports ?from=ISO&to=ISO date range (defaults to current month).
   */
  router.get("/companies/:companyId/analytics/token-efficiency", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseCostDateRange(req.query);
    const rows = await analytics.tokenEfficiency(companyId, range);
    res.json(rows);
  });

  return router;
}
