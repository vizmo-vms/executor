import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "@effect/vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const syncScript = join(repoRoot, "scripts/codegraph-repo-sync.sh");

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
const gitOutput = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("CodeGraph repository sync", () => {
  it("supplies private GitHub credentials through askpass", () => {
    const env = { ...process.env, EXECUTOR_CODEGRAPH_GITHUB_TOKEN: "test-secret" };
    const username = execFileSync("sh", [syncScript, "Username for https://github.com"], {
      env,
      encoding: "utf8",
    });
    const password = execFileSync("sh", [syncScript, "Password for https://github.com"], {
      env,
      encoding: "utf8",
    });

    expect(username.trim()).toBe("x-access-token");
    expect(password.trim()).toBe("test-secret");
  });

  it("clones and fast-forwards configured prod branches without touching dirty repositories", () => {
    const root = mkdtempSync(join(tmpdir(), "executor-codegraph-sync-"));
    const github = join(root, "github");
    const remote = join(github, "acme", "private-repo.git");
    const upstream = join(root, "upstream");
    const workspace = join(root, "workspace");
    const repository = join(workspace, "acme", "private-repo");
    const fakeBin = join(root, "bin");
    const syncLog = join(root, "codegraph.log");
    const githubBaseUrl = `file://${github}`;

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: test owns and removes its temporary repositories
    try {
      mkdirSync(upstream);
      mkdirSync(workspace);
      mkdirSync(fakeBin);
      mkdirSync(join(github, "acme"), { recursive: true });
      git(root, "init", "--bare", "--initial-branch=prod", remote);
      git(upstream, "init", "--initial-branch=prod");
      git(upstream, "config", "user.email", "codegraph-sync@example.invalid");
      git(upstream, "config", "user.name", "CodeGraph Sync Test");
      writeFileSync(join(upstream, "example.ts"), "export const version = 1;\n");
      git(upstream, "add", "example.ts");
      git(upstream, "commit", "-m", "initial");
      git(upstream, "remote", "add", "origin", remote);
      git(upstream, "push", "--set-upstream", "origin", "prod");

      const fakeCodegraph = join(fakeBin, "codegraph");
      writeFileSync(
        fakeCodegraph,
        '#!/bin/sh\n[ -z "${EXECUTOR_CODEGRAPH_GITHUB_TOKEN:-}" ] || exit 99\nprintf "%s\\n" "$*" >> "$CODEGRAPH_SYNC_LOG"\n[ "$1" != init ] || mkdir -p "$2/.codegraph"\n',
      );
      chmodSync(fakeCodegraph, 0o755);

      const env = {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        CODEGRAPH_SYNC_LOG: syncLog,
        EXECUTOR_CODEGRAPH_WORKSPACE: workspace,
        EXECUTOR_CODEGRAPH_GITHUB_REPOS: "acme/private-repo",
        EXECUTOR_CODEGRAPH_GITHUB_BRANCH: "prod",
        EXECUTOR_CODEGRAPH_GITHUB_BASE_URL: githubBaseUrl,
        EXECUTOR_CODEGRAPH_GITHUB_TOKEN: "test-secret",
      };
      execFileSync("sh", [syncScript], { env, stdio: "ignore" });

      expect(readFileSync(join(repository, "example.ts"), "utf8")).toContain("version = 1");
      expect(gitOutput(repository, "branch", "--show-current")).toBe("prod");
      expect(gitOutput(repository, "remote", "get-url", "origin")).toBe(
        `${githubBaseUrl}/acme/private-repo.git`,
      );
      expect(readFileSync(syncLog, "utf8").trim()).toBe(`init ${repository}`);

      writeFileSync(join(upstream, "example.ts"), "export const version = 2;\n");
      git(upstream, "add", "example.ts");
      git(upstream, "commit", "-m", "update");
      git(upstream, "push");

      writeFileSync(syncLog, "");
      execFileSync("sh", [syncScript], { env, stdio: "ignore" });
      expect(readFileSync(join(repository, "example.ts"), "utf8")).toContain("version = 2");
      expect(readFileSync(syncLog, "utf8").trim()).toBe(`sync ${repository}`);

      writeFileSync(join(repository, "example.ts"), "export const version = 'local';\n");
      writeFileSync(join(upstream, "example.ts"), "export const version = 3;\n");
      git(upstream, "add", "example.ts");
      git(upstream, "commit", "-m", "another update");
      git(upstream, "push");

      writeFileSync(syncLog, "");
      execFileSync("sh", [syncScript], { env, stdio: "ignore" });
      expect(readFileSync(join(repository, "example.ts"), "utf8")).toContain("'local'");
      expect(readFileSync(syncLog, "utf8").trim()).toBe(`sync ${repository}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
