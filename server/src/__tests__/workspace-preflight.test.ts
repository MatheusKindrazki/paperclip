import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { agents, executionWorkspaces } from "@paperclipai/db";
import {
  runWorkspacePreflight,
  setLastWorkspacePreflightReport,
  getLastWorkspacePreflightReport,
  _resetLastWorkspacePreflightReportForTests,
} from "../services/workspace-preflight.ts";

const execFileAsync = promisify(execFile);

/**
 * Minimal fake db: the preflight only uses `select().from(table).where()` and
 * awaits the result. We branch on the table identity to return the right rows.
 * The rows passed in are already pre-filtered (active / non-paused) by the test.
 */
function makeFakeDb(rows: { workspaces: Record<string, unknown>[]; agents: Record<string, unknown>[] }): Db {
  const select = () => ({
    from: (table: unknown) => ({
      where: () =>
        Promise.resolve(
          Object.is(table, executionWorkspaces)
            ? rows.workspaces
            : Object.is(table, agents)
              ? rows.agents
              : [],
        ),
    }),
  });
  return { select } as unknown as Db;
}

describe("runWorkspacePreflight (MOKA-5031)", () => {
  let gitRepo: string;
  let nonGitDir: string;
  const created: string[] = [];

  beforeAll(async () => {
    gitRepo = await mkdtemp(join(tmpdir(), "preflight-git-"));
    created.push(gitRepo);
    await execFileAsync("git", ["-C", gitRepo, "init", "-q"]);

    nonGitDir = await mkdtemp(join(tmpdir(), "preflight-nogit-"));
    created.push(nonGitDir);
  });

  afterAll(async () => {
    _resetLastWorkspacePreflightReportForTests();
    await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("passes when active git workspaces and agents resolve to valid worktrees", async () => {
    const db = makeFakeDb({
      workspaces: [
        {
          id: "ws-ok",
          companyId: "co",
          name: "ok",
          cwd: gitRepo,
          providerType: "git_worktree",
          providerRef: null,
          repoUrl: "https://example/repo.git",
          baseRef: "main",
          branchName: "ws-ok",
        },
      ],
      agents: [
        {
          id: "agent-ok",
          companyId: "co",
          name: "claude",
          adapterType: "claude_local",
          adapterConfig: { cwd: gitRepo },
        },
      ],
    });

    const report = await runWorkspacePreflight(db);

    expect(report.ok).toBe(true);
    expect(report.offenders).toEqual([]);
    expect(report.workspaceCount).toBe(1);
    expect(report.agentCount).toBe(1);
  });

  it("fails closed when an active workspace cwd does not exist", async () => {
    const db = makeFakeDb({
      workspaces: [
        {
          id: "ws-missing",
          companyId: "co",
          name: "missing",
          cwd: join(tmpdir(), "preflight-definitely-missing-" + gitRepo.slice(-6)),
          providerType: "git_worktree",
          providerRef: null,
          repoUrl: "https://example/repo.git",
          baseRef: "main",
          branchName: "ws-missing",
        },
      ],
      agents: [],
    });

    const report = await runWorkspacePreflight(db);

    expect(report.ok).toBe(false);
    expect(report.offenders).toHaveLength(1);
    expect(report.offenders[0]).toMatchObject({
      kind: "execution_workspace",
      id: "ws-missing",
      reason: expect.stringContaining("does not exist"),
    });
  });

  it("fails closed when an agent adapterConfig.cwd exists but is not a git worktree", async () => {
    const db = makeFakeDb({
      workspaces: [],
      agents: [
        {
          id: "agent-nogit",
          companyId: "co",
          name: "claude",
          adapterType: "claude_local",
          adapterConfig: { cwd: nonGitDir },
        },
      ],
    });

    const report = await runWorkspacePreflight(db);

    expect(report.ok).toBe(false);
    expect(report.offenders).toHaveLength(1);
    expect(report.offenders[0]).toMatchObject({
      kind: "agent",
      id: "agent-nogit",
      adapterType: "claude_local",
      reason: expect.stringContaining("not a git worktree"),
    });
  });

  it("ignores process/http agents and non-git workspaces", async () => {
    const db = makeFakeDb({
      workspaces: [
        {
          // local_fs workspace with no git signals -> not validated
          id: "ws-local",
          companyId: "co",
          name: "local",
          cwd: nonGitDir,
          providerType: "local_fs",
          providerRef: null,
          repoUrl: null,
          baseRef: null,
          branchName: null,
        },
      ],
      agents: [
        {
          // process adapter -> not validated even with a cwd
          id: "agent-process",
          companyId: "co",
          name: "proc",
          adapterType: "process",
          adapterConfig: { cwd: nonGitDir },
        },
      ],
    });

    const report = await runWorkspacePreflight(db);

    expect(report.ok).toBe(true);
    expect(report.offenders).toEqual([]);
  });

  it("stores the report so the health path can surface it", async () => {
    const db = makeFakeDb({
      workspaces: [
        {
          id: "ws-store",
          companyId: "co",
          name: "store",
          cwd: nonGitDir,
          providerType: "git_worktree",
          providerRef: null,
          repoUrl: "https://example/repo.git",
          baseRef: "main",
          branchName: "x",
        },
      ],
      agents: [],
    });

    const report = await runWorkspacePreflight(db);
    setLastWorkspacePreflightReport(report);

    const stored = getLastWorkspacePreflightReport();
    expect(stored).toBe(report);
    expect(stored?.ok).toBe(false);
    expect(stored?.offenders).toHaveLength(1);
  });
});
