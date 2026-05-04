import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const baseAgent = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "company-1",
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Builder",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "process",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false, canAssignTasks: false },
  lastHeartbeatAt: null,
  metadata: null,
  defaultEnvironmentId: null,
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-03-19T00:00:00.000Z"),
};

const baseCompany = {
  id: "company-1",
  name: "Paperclip",
  description: null,
  status: "active",
  issuePrefix: "PAP",
  issueCounter: 0,
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  requireBoardApprovalForNewAgents: false,
  brandColor: null,
  logoAssetId: null,
  logoUrl: null,
  pauseReason: null,
  pausedAt: null,
  feedbackDataSharingEnabled: false,
  attachmentMaxBytes: null,
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-03-19T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
  stats: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => true),
  hasPermission: vi.fn(async () => true),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(async () => ({})),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({}));
const mockHeartbeatService = vi.hoisted(() => ({}));
const mockIssueApprovalService = vi.hoisted(() => ({}));
const mockIssueService = vi.hoisted(() => ({}));
const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(() => []),
}));
const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
}));
const mockCompanyPortabilityService = vi.hoisted(() => ({}));
const mockFeedbackService = vi.hoisted(() => ({}));
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn((_existing, config) => config));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackAgentCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockEnsureOpenCodeModelConfiguredAndAvailable = vi.hoisted(() => vi.fn());
const mockFindServerAdapter = vi.hoisted(() => vi.fn(() => null));
const mockListAdapterModels = vi.hoisted(() => vi.fn(() => []));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  approvalService: () => mockApprovalService,
  budgetService: () => mockBudgetService,
  companyService: () => mockCompanyService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companySkillService: () => mockCompanySkillService,
  environmentService: () => mockEnvironmentService,
  feedbackService: () => mockFeedbackService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  workspaceOperationService: () => ({}),
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: mockFindServerAdapter,
  listAdapterModels: mockListAdapterModels,
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentCreated: mockTrackAgentCreated,
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("@paperclipai/adapter-opencode-local/server", () => ({
  ensureOpenCodeModelConfiguredAndAvailable: mockEnsureOpenCodeModelConfiguredAndAvailable,
}));

const boardActor = {
  type: "board" as const,
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

async function createAgentApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = boardActor;
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function createCompanyApp() {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/companies.js")>("../routes/companies.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = boardActor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("budget policy sync on PATCH routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("PATCH /api/agents/:id", () => {
    it("calls budgetService.upsertPolicy when budgetMonthlyCents is in the body", async () => {
      mockAgentService.getById.mockResolvedValue(baseAgent);
      mockAgentService.update.mockResolvedValue({ ...baseAgent, budgetMonthlyCents: 25000 });

      const app = await createAgentApp();
      const res = await request(app)
        .patch(`/api/agents/${baseAgent.id}`)
        .send({ budgetMonthlyCents: 25000 });

      expect(res.status).toBe(200);
      expect(mockBudgetService.upsertPolicy).toHaveBeenCalledTimes(1);
      expect(mockBudgetService.upsertPolicy).toHaveBeenCalledWith(
        baseAgent.companyId,
        {
          scopeType: "agent",
          scopeId: baseAgent.id,
          amount: 25000,
          windowKind: "calendar_month_utc",
        },
        "local-board",
      );
    });

    it("does NOT call budgetService.upsertPolicy when budgetMonthlyCents is absent", async () => {
      mockAgentService.getById.mockResolvedValue(baseAgent);
      mockAgentService.update.mockResolvedValue({ ...baseAgent, title: "Renamed" });

      const app = await createAgentApp();
      const res = await request(app)
        .patch(`/api/agents/${baseAgent.id}`)
        .send({ title: "Renamed" });

      expect(res.status).toBe(200);
      expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
    });

    it("syncs zero budget so policy becomes inactive", async () => {
      mockAgentService.getById.mockResolvedValue({ ...baseAgent, budgetMonthlyCents: 25000 });
      mockAgentService.update.mockResolvedValue({ ...baseAgent, budgetMonthlyCents: 0 });

      const app = await createAgentApp();
      const res = await request(app)
        .patch(`/api/agents/${baseAgent.id}`)
        .send({ budgetMonthlyCents: 0 });

      expect(res.status).toBe(200);
      expect(mockBudgetService.upsertPolicy).toHaveBeenCalledWith(
        baseAgent.companyId,
        {
          scopeType: "agent",
          scopeId: baseAgent.id,
          amount: 0,
          windowKind: "calendar_month_utc",
        },
        "local-board",
      );
    });
  });

  describe("PATCH /api/companies/:companyId", () => {
    it("calls budgetService.upsertPolicy when budgetMonthlyCents is in the body", async () => {
      mockCompanyService.getById.mockResolvedValue(baseCompany);
      mockCompanyService.update.mockResolvedValue({ ...baseCompany, budgetMonthlyCents: 250000 });

      const app = await createCompanyApp();
      const res = await request(app)
        .patch(`/api/companies/${baseCompany.id}`)
        .send({ budgetMonthlyCents: 250000 });

      expect(res.status).toBe(200);
      expect(mockBudgetService.upsertPolicy).toHaveBeenCalledTimes(1);
      expect(mockBudgetService.upsertPolicy).toHaveBeenCalledWith(
        baseCompany.id,
        {
          scopeType: "company",
          scopeId: baseCompany.id,
          amount: 250000,
          windowKind: "calendar_month_utc",
        },
        "local-board",
      );
    });

    it("does NOT call budgetService.upsertPolicy when budgetMonthlyCents is absent", async () => {
      mockCompanyService.getById.mockResolvedValue(baseCompany);
      mockCompanyService.update.mockResolvedValue({ ...baseCompany, name: "Renamed" });

      const app = await createCompanyApp();
      const res = await request(app)
        .patch(`/api/companies/${baseCompany.id}`)
        .send({ name: "Renamed" });

      expect(res.status).toBe(200);
      expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
    });
  });
});
