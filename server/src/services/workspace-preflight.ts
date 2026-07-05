import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, executionWorkspaces } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const execFileAsync = promisify(execFile);

/**
 * Adapter types that do NOT execute against a local git repository. Everything
 * else (claude_local, cursor, …) is treated as expecting a git workspace, which
 * matches the runtime behaviour that produced `workspace_validation_failed` in
 * MOKA-5012 ("expected a git workspace for claude_local").
 */
const NON_GIT_ADAPTER_TYPES = new Set(["process", "http"]);

export type WorkspacePreflightOffenderKind = "execution_workspace" | "agent";

export interface WorkspacePreflightOffender {
  kind: WorkspacePreflightOffenderKind;
  id: string;
  companyId: string;
  /** Agent name or workspace name, for human-readable alerts. */
  name?: string;
  /** The cwd that failed validation, if any could be resolved. */
  cwd: string | null;
  reason: string;
  /** Present for agent offenders. */
  adapterType?: string;
}

export interface WorkspacePreflightReport {
  /** True when no offender was found and the fleet may be enabled. */
  ok: boolean;
  checkedAt: string;
  workspaceCount: number;
  agentCount: number;
  offenders: WorkspacePreflightOffender[];
  /** Set when the preflight could not read its inputs; fleet is NOT blocked. */
  queryError?: string;
}

function emptyReport(ok: boolean, extra: Partial<WorkspacePreflightReport> = {}): WorkspacePreflightReport {
  return {
    ok,
    checkedAt: new Date().toISOString(),
    workspaceCount: 0,
    agentCount: 0,
    offenders: [],
    ...extra,
  };
}

async function pathExists(value: string | null | undefined): Promise<boolean> {
  if (!value) return false;
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

async function isInsideWorkTree(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      cwd,
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** A workspace requires a git checkout when it was created as a git workspace. */
function executionWorkspaceExpectsGit(row: {
  providerType: string | null;
  repoUrl: string | null;
  baseRef: string | null;
  branchName: string | null;
}): boolean {
  return (
    row.providerType === "git_worktree" ||
    Boolean(row.repoUrl || row.baseRef || row.branchName)
  );
}

function readAdapterCwd(adapterConfig: unknown): string | null {
  if (typeof adapterConfig !== "object" || adapterConfig === null) return null;
  const raw = (adapterConfig as Record<string, unknown>).cwd;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validate every active execution-workspace cwd and every non-paused agent's
 * adapterConfig.cwd BEFORE the orchestrator enables the agent fleet after a
 * restart (MOKA-5031). Any path that requires a git workspace must exist and
 * `git -C <cwd> rev-parse --is-inside-work-tree` must succeed.
 *
 * Fail-closed contract: the caller MUST NOT enable the fleet when `ok` is false.
 *
 * Transient DB read errors are intentionally NON-blocking — hiding a DB outage
 * behind a fleet-preflight message would be a worse failure mode than the one
 * this guards against, and the DB is already probed on the health path. The
 * error is surfaced via `queryError` so it is still observable.
 */
export async function runWorkspacePreflight(db: Db): Promise<WorkspacePreflightReport> {
  const offenders: WorkspacePreflightOffender[] = [];
  let workspaces: Array<{
    id: string;
    companyId: string;
    name: string;
    cwd: string | null;
    providerType: string | null;
    providerRef: string | null;
    repoUrl: string | null;
    baseRef: string | null;
    branchName: string | null;
  }>;
  let agentRows: Array<{
    id: string;
    companyId: string;
    name: string;
    adapterType: string | null;
    adapterConfig: unknown;
  }>;

  try {
    workspaces = await db
      .select({
        id: executionWorkspaces.id,
        companyId: executionWorkspaces.companyId,
        name: executionWorkspaces.name,
        cwd: executionWorkspaces.cwd,
        providerType: executionWorkspaces.providerType,
        providerRef: executionWorkspaces.providerRef,
        repoUrl: executionWorkspaces.repoUrl,
        baseRef: executionWorkspaces.baseRef,
        branchName: executionWorkspaces.branchName,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.status, "active"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "workspace preflight: failed to read execution_workspaces");
    return emptyReport(true, { queryError: `execution_workspaces: ${message}` });
  }

  try {
    agentRows = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(ne(agents.status, "paused"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "workspace preflight: failed to read agents");
    return emptyReport(true, { queryError: `agents: ${message}` });
  }

  for (const ws of workspaces) {
    if (!executionWorkspaceExpectsGit(ws)) continue;
    const cwd = (ws.cwd ?? ws.providerRef ?? "").trim() || null;
    if (!cwd) {
      offenders.push({
        kind: "execution_workspace",
        id: ws.id,
        companyId: ws.companyId,
        name: ws.name,
        cwd: null,
        reason: "git workspace has no resolvable cwd",
      });
      continue;
    }
    if (!(await pathExists(cwd))) {
      offenders.push({
        kind: "execution_workspace",
        id: ws.id,
        companyId: ws.companyId,
        name: ws.name,
        cwd,
        reason: "cwd path does not exist",
      });
      continue;
    }
    if (!(await isInsideWorkTree(cwd))) {
      offenders.push({
        kind: "execution_workspace",
        id: ws.id,
        companyId: ws.companyId,
        name: ws.name,
        cwd,
        reason: "git rev-parse --is-inside-work-tree failed (not a git worktree)",
      });
    }
  }

  for (const agent of agentRows) {
    const adapterType = agent.adapterType ?? "process";
    if (NON_GIT_ADAPTER_TYPES.has(adapterType)) continue;
    const cwd = readAdapterCwd(agent.adapterConfig);
    if (!cwd) continue;
    if (!(await pathExists(cwd))) {
      offenders.push({
        kind: "agent",
        id: agent.id,
        companyId: agent.companyId,
        name: agent.name,
        cwd,
        adapterType,
        reason: "adapterConfig.cwd path does not exist",
      });
      continue;
    }
    if (!(await isInsideWorkTree(cwd))) {
      offenders.push({
        kind: "agent",
        id: agent.id,
        companyId: agent.companyId,
        name: agent.name,
        cwd,
        adapterType,
        reason: "git rev-parse --is-inside-work-tree failed (not a git worktree)",
      });
    }
  }

  return {
    ok: offenders.length === 0,
    checkedAt: new Date().toISOString(),
    workspaceCount: workspaces.length,
    agentCount: agentRows.length,
    offenders,
  };
}

// In-memory store so the health/uptime route can surface the most recent
// preflight result to the SRE monitor (MOKA-5009: nothing caught the standstill).
let lastReport: WorkspacePreflightReport | null = null;

export function setLastWorkspacePreflightReport(report: WorkspacePreflightReport): void {
  lastReport = report;
}

export function getLastWorkspacePreflightReport(): WorkspacePreflightReport | null {
  return lastReport;
}

/** Test-only escape hatch (preflight normally runs exactly once per restart). */
export function _resetLastWorkspacePreflightReportForTests(): void {
  lastReport = null;
}
