import { and, desc, eq, gte, inArray, lt, ne, not, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, costEvents, heartbeatRuns, issues } from "@paperclipai/db";

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

function sumAsNumber(
  column:
    | typeof costEvents.costCents
    | typeof costEvents.inputTokens
    | typeof costEvents.cachedInputTokens
    | typeof costEvents.outputTokens,
) {
  return sql<number>`coalesce(sum(${column}), 0)::double precision`;
}

export interface CostDateRange {
  from?: Date;
  to?: Date;
}

export function analyticsService(db: Db) {
  return {
    /**
     * Bulk agent status: returns every non-terminated agent with current
     * status, active-issue count, month-to-date run stats, and spend.
     */
    bulkAgentStatus: async (companyId: string) => {
      const { start, end } = currentUtcMonthWindow();

      const agentRows = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

      if (agentRows.length === 0) return [];

      const agentIds = agentRows.map((a) => a.id);

      // Active issues per agent (not done/cancelled)
      const issueCountRows = await db
        .select({
          agentId: issues.assigneeAgentId,
          count: sql<number>`count(*)::int`,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.assigneeAgentId, agentIds),
            not(inArray(issues.status, ["done", "cancelled"])),
          ),
        )
        .groupBy(issues.assigneeAgentId);

      // MTD run stats per agent
      const runStatsRows = await db
        .select({
          agentId: heartbeatRuns.agentId,
          total: sql<number>`count(*)::int`,
          succeeded: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'succeeded')::int`,
          failed: sql<number>`count(*) filter (where ${heartbeatRuns.status} in ('failed', 'timed_out'))::int`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.agentId, agentIds),
            gte(heartbeatRuns.createdAt, start),
            lt(heartbeatRuns.createdAt, end),
          ),
        )
        .groupBy(heartbeatRuns.agentId);

      // MTD spend per agent
      const spendRows = await db
        .select({
          agentId: costEvents.agentId,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            inArray(costEvents.agentId, agentIds),
            gte(costEvents.occurredAt, start),
            lt(costEvents.occurredAt, end),
          ),
        )
        .groupBy(costEvents.agentId);

      const issueMap = new Map(issueCountRows.map((r) => [r.agentId, Number(r.count)]));
      const runMap = new Map(
        runStatsRows.map((r) => [
          r.agentId,
          { total: Number(r.total), succeeded: Number(r.succeeded), failed: Number(r.failed) },
        ]),
      );
      const spendMap = new Map(
        spendRows.map((r) => [
          r.agentId,
          {
            costCents: Number(r.costCents),
            inputTokens: Number(r.inputTokens),
            outputTokens: Number(r.outputTokens),
          },
        ]),
      );

      return agentRows.map((agent) => ({
        agentId: agent.id,
        name: agent.name,
        role: agent.role,
        title: agent.title,
        status: agent.status,
        lastHeartbeatAt: agent.lastHeartbeatAt,
        budgetMonthlyCents: agent.budgetMonthlyCents,
        activeIssues: issueMap.get(agent.id) ?? 0,
        monthRuns: runMap.get(agent.id) ?? { total: 0, succeeded: 0, failed: 0 },
        monthSpend: spendMap.get(agent.id) ?? { costCents: 0, inputTokens: 0, outputTokens: 0 },
      }));
    },

    /**
     * Validation ledger: per-project summary of issues that moved through
     * review (in_review → done) with run-count and cost attribution.
     */
    validationLedger: async (companyId: string, range?: CostDateRange) => {
      const conditions = [
        eq(issues.companyId, companyId),
        eq(issues.status, "done"),
        sql`${issues.completedAt} is not null`,
      ];
      if (range?.from) conditions.push(gte(issues.completedAt!, range.from));
      if (range?.to) conditions.push(lt(issues.completedAt!, range.to));

      const rows = await db
        .select({
          projectId: issues.projectId,
          completedCount: sql<number>`count(*)::int`,
          avgCycleHours: sql<number>`coalesce(avg(extract(epoch from (${issues.completedAt} - ${issues.startedAt})) / 3600.0), 0)::double precision`,
          earliestCompleted: sql<string>`min(${issues.completedAt})::text`,
          latestCompleted: sql<string>`max(${issues.completedAt})::text`,
        })
        .from(issues)
        .where(and(...conditions))
        .groupBy(issues.projectId);

      // Get cost per project for the same period
      const costConditions = [eq(costEvents.companyId, companyId)];
      if (range?.from) costConditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) costConditions.push(lt(costEvents.occurredAt, range.to));

      const costRows = await db
        .select({
          projectId: costEvents.projectId,
          costCents: sumAsNumber(costEvents.costCents),
          totalTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}) + sum(${costEvents.outputTokens}), 0)::double precision`,
        })
        .from(costEvents)
        .where(and(...costConditions))
        .groupBy(costEvents.projectId);

      const costMap = new Map(
        costRows.map((r) => [
          r.projectId,
          { costCents: Number(r.costCents), totalTokens: Number(r.totalTokens) },
        ]),
      );

      return rows.map((row) => {
        const cost = costMap.get(row.projectId) ?? { costCents: 0, totalTokens: 0 };
        const completed = Number(row.completedCount);
        return {
          projectId: row.projectId,
          completedIssues: completed,
          avgCycleHours: Number(Number(row.avgCycleHours).toFixed(2)),
          costCents: cost.costCents,
          totalTokens: cost.totalTokens,
          tokensPerIssue: completed > 0 ? Math.round(cost.totalTokens / completed) : 0,
          costPerIssueCents: completed > 0 ? Number((cost.costCents / completed).toFixed(2)) : 0,
          earliestCompleted: row.earliestCompleted,
          latestCompleted: row.latestCompleted,
        };
      });
    },

    /**
     * Token efficiency per agent: tokens consumed vs. issues completed,
     * giving a per-agent productivity ratio.
     */
    tokenEfficiency: async (companyId: string, range?: CostDateRange) => {
      const { start, end } = currentUtcMonthWindow();
      const from = range?.from ?? start;
      const to = range?.to ?? end;

      // Completed issues per agent in the period
      const issueRows = await db
        .select({
          agentId: issues.assigneeAgentId,
          completedCount: sql<number>`count(*)::int`,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.status, "done"),
            sql`${issues.completedAt} is not null`,
            gte(issues.completedAt!, from),
            lt(issues.completedAt!, to),
            sql`${issues.assigneeAgentId} is not null`,
          ),
        )
        .groupBy(issues.assigneeAgentId);

      // Token spend per agent in the period
      const costRows = await db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          runCount: sql<number>`count(distinct ${costEvents.heartbeatRunId})::int`,
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, from),
            lt(costEvents.occurredAt, to),
          ),
        )
        .groupBy(costEvents.agentId, agents.name)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));

      const issueMap = new Map(issueRows.map((r) => [r.agentId, Number(r.completedCount)]));

      return costRows.map((row) => {
        const totalTokens = Number(row.inputTokens) + Number(row.outputTokens);
        const completed = issueMap.get(row.agentId) ?? 0;
        const runs = Number(row.runCount);
        const cacheRate =
          Number(row.inputTokens) > 0
            ? Number(((Number(row.cachedInputTokens) / Number(row.inputTokens)) * 100).toFixed(2))
            : 0;

        return {
          agentId: row.agentId,
          agentName: row.agentName,
          costCents: Number(row.costCents),
          inputTokens: Number(row.inputTokens),
          cachedInputTokens: Number(row.cachedInputTokens),
          outputTokens: Number(row.outputTokens),
          totalTokens,
          cacheHitPercent: cacheRate,
          runs,
          completedIssues: completed,
          tokensPerIssue: completed > 0 ? Math.round(totalTokens / completed) : null,
          tokensPerRun: runs > 0 ? Math.round(totalTokens / runs) : null,
          costPerIssueCents: completed > 0 ? Number((Number(row.costCents) / completed).toFixed(2)) : null,
          costPerRunCents: runs > 0 ? Number((Number(row.costCents) / runs).toFixed(2)) : null,
        };
      });
    },
  };
}
