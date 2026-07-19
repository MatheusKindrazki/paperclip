import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAnalyticsService = vi.hoisted(() => ({
  bulkAgentStatus: vi.fn(),
  validationLedger: vi.fn(),
  tokenEfficiency: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("../services/analytics.js", () => ({
    analyticsService: () => mockAnalyticsService,
  }));
}

async function createApp() {
  const [{ analyticsRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/analytics.js")>("../routes/analytics.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", analyticsRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

describe("analytics routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/analytics.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
  });

  describe("GET /companies/:companyId/analytics/agents-status", () => {
    it("returns bulk agent status", async () => {
      const mockData = [
        {
          agentId: "agent-1",
          name: "SRE Engineer",
          role: "sre",
          title: "SRE",
          status: "idle",
          lastHeartbeatAt: "2026-04-29T10:00:00.000Z",
          budgetMonthlyCents: 10000,
          activeIssues: 2,
          monthRuns: { total: 10, succeeded: 8, failed: 2 },
          monthSpend: { costCents: 500, inputTokens: 100000, outputTokens: 50000 },
        },
      ];
      mockAnalyticsService.bulkAgentStatus.mockResolvedValue(mockData);

      const app = await createApp();
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).get("/api/companies/company-1/analytics/agents-status"),
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].agentId).toBe("agent-1");
      expect(res.body[0].monthRuns.total).toBe(10);
      expect(mockAnalyticsService.bulkAgentStatus).toHaveBeenCalledWith("company-1");
    });

});

  describe("GET /companies/:companyId/analytics/validation-ledger", () => {
    it("returns project validation ledger", async () => {
      const mockData = [
        {
          projectId: "proj-1",
          completedIssues: 5,
          avgCycleHours: 12.5,
          costCents: 2500,
          totalTokens: 500000,
          tokensPerIssue: 100000,
          costPerIssueCents: 500,
          earliestCompleted: "2026-04-01T00:00:00.000Z",
          latestCompleted: "2026-04-28T00:00:00.000Z",
        },
      ];
      mockAnalyticsService.validationLedger.mockResolvedValue(mockData);

      const app = await createApp();
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).get("/api/companies/company-1/analytics/validation-ledger"),
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].completedIssues).toBe(5);
      expect(res.body[0].tokensPerIssue).toBe(100000);
      expect(mockAnalyticsService.validationLedger).toHaveBeenCalledWith("company-1", undefined);
    });

    it("passes date range parameters", async () => {
      mockAnalyticsService.validationLedger.mockResolvedValue([]);

      const app = await createApp();
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl)
          .get("/api/companies/company-1/analytics/validation-ledger")
          .query({ from: "2026-04-01", to: "2026-04-30" }),
      );

      expect(res.status).toBe(200);
      expect(mockAnalyticsService.validationLedger).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({
          from: expect.any(Date),
          to: expect.any(Date),
        }),
      );
    });
  });

  describe("GET /companies/:companyId/analytics/token-efficiency", () => {
    it("returns per-agent token efficiency", async () => {
      const mockData = [
        {
          agentId: "agent-1",
          agentName: "SRE Engineer",
          costCents: 1200,
          inputTokens: 200000,
          cachedInputTokens: 80000,
          outputTokens: 100000,
          totalTokens: 300000,
          cacheHitPercent: 40,
          runs: 15,
          completedIssues: 3,
          tokensPerIssue: 100000,
          tokensPerRun: 20000,
          costPerIssueCents: 400,
          costPerRunCents: 80,
        },
      ];
      mockAnalyticsService.tokenEfficiency.mockResolvedValue(mockData);

      const app = await createApp();
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).get("/api/companies/company-1/analytics/token-efficiency"),
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].cacheHitPercent).toBe(40);
      expect(res.body[0].tokensPerRun).toBe(20000);
      expect(mockAnalyticsService.tokenEfficiency).toHaveBeenCalledWith("company-1", undefined);
    });

    it("passes date range parameters", async () => {
      mockAnalyticsService.tokenEfficiency.mockResolvedValue([]);

      const app = await createApp();
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl)
          .get("/api/companies/company-1/analytics/token-efficiency")
          .query({ from: "2026-04-01", to: "2026-04-30" }),
      );

      expect(res.status).toBe(200);
      expect(mockAnalyticsService.tokenEfficiency).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({
          from: expect.any(Date),
          to: expect.any(Date),
        }),
      );
    });
  });
});
