/**
 * Project boundaries: session modes, the options and status routes, a
 * project's boundary, the organization's settings, and the boundary refusals as
 * typed errors. The Python SDK's tests/test_project_boundaries.py pins the same
 * behaviour.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BoundaryBelowMinimumError,
  ProjectContentLockedError,
  SessionAlreadyStartedError,
  SessionSelectionInvalidError,
  SettingRetiredError,
} from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const A = "pa";
const CHEM = "pc";

function refusal(status: number, code: string, message: string, extras: Record<string, unknown> = {}) {
  return json(
    {
      detail: { code, message, fix: "Do this.", ...extras },
      error: { code, message, fix: "Do this.", details: extras },
    },
    status,
  );
}

function session(extra: Record<string, unknown> = {}) {
  return {
    id: "s1",
    status: "active",
    mode: "picked",
    summary: "Picked session: reads Partner A; writes Partner A.",
    notes: [],
    ...extra,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("session modes", () => {
  it("create sends read_everything and no lists", async () => {
    const { fetch, calls } = mockFetch([
      json({ ...session({ mode: "read_everything" }), token: { token: "bk_st_x", expires_at: "2099-01-01T00:00:00Z" } }, 201),
    ]);
    const scoped = await client(fetch).beakr.sessions.create({ readEverything: true });
    expect(calls[0]!.body).toMatchObject({ read_everything: true });
    expect(calls[0]!.body).not.toHaveProperty("read_project_ids");
    expect(scoped.session.mode).toBe("read_everything");
  });

  it("start declares a picked session; write alone reads the same projects", async () => {
    const { fetch, calls } = mockFetch([json(session(), 201)]);
    const s = await client(fetch).beakr.sessions.start({ write: [A] });
    expect(calls[0]!.body).toMatchObject({ read_project_ids: [A], write_project_ids: [A] });
    expect(s.session?.summary).toMatch(/^Picked session/);
  });

  it("update sends read_everything", async () => {
    const { fetch, calls } = mockFetch([json(session({ mode: "read_everything" }))]);
    await client(fetch).beakr.sessions.update("s1", { readEverything: true });
    expect(calls[0]!.body).toEqual({ read_everything: true });
  });

  it("a choice that breaks a boundary is typed with every reason", async () => {
    const reasons = [
      { code: "locked_read_limits_writes", message: "Reading Partner A locks writes.", project_ids: [A, CHEM] },
      { code: "blocked_write_limits_reads", message: "Chemistry takes no content.", project_ids: [CHEM] },
    ];
    const { fetch } = mockFetch([refusal(422, "session_selection_invalid", reasons[0]!.message, { reasons })]);
    const error = await client(fetch)
      .beakr.sessions.create({ read: [A], write: [CHEM] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionSelectionInvalidError);
    const invalid = error as SessionSelectionInvalidError;
    expect(invalid.reasons.map((r) => r.code)).toEqual(["locked_read_limits_writes", "blocked_write_limits_reads"]);
    expect(invalid.reasonMessages[1]).toBe("Chemistry takes no content.");
  });

  it("declaring a session that already worked is typed", async () => {
    const { fetch } = mockFetch([refusal(409, "session_already_started", "This session has already worked in Partner A.")]);
    await expect(client(fetch).beakr.sessions.update("s1", { readEverything: true })).rejects.toBeInstanceOf(
      SessionAlreadyStartedError,
    );
  });
});

describe("options and status", () => {
  it("options sends the lists so far", async () => {
    const answer = { valid: true, reasons: [], notes: [], projects: [], read_everything: { summary: "x" } };
    const { fetch, calls } = mockFetch([json(answer), json(answer)]);
    const { beakr } = client(fetch);
    expect(await beakr.sessions.options({ read: [A] })).toEqual(answer);
    await beakr.sessions.options();
    expect(calls.map((c) => [c.method, new URL(c.url).pathname, c.body])).toEqual([
      ["POST", "/v1/sessions/options", { read_project_ids: [A], write_project_ids: [] }],
      ["POST", "/v1/sessions/options", { read_project_ids: [], write_project_ids: [] }],
    ]);
  });

  it("status of the current session, or one by id", async () => {
    const status = { session_id: "s1", mode: "automatic", summary: "Automatic session." };
    const { fetch, calls } = mockFetch([json(status), json(status)]);
    const { beakr } = client(fetch);
    expect((await beakr.sessions.status()).summary).toBe("Automatic session.");
    await beakr.sessions.status("s1");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/v1/sessions/current/status",
      "/v1/sessions/s1/status",
    ]);
  });
});

describe("a project's boundary", () => {
  it("setBoundary sends a preset or the values", async () => {
    const project = { id: A, name: "Partner A", boundary: { preset: "siloed" } };
    const { fetch, calls } = mockFetch([json(project), json(project)]);
    const { beakr } = client(fetch);
    await beakr.projects.setBoundary(A, { preset: "siloed" });
    await beakr.projects.setBoundary(A, { contentIn: "blocked" });
    expect(calls.map((c) => [c.method, new URL(c.url).pathname, c.body])).toEqual([
      ["PATCH", `/v1/projects/${A}`, { boundary_preset: "siloed" }],
      ["PATCH", `/v1/projects/${A}`, { boundary: { content_in: "blocked" } }],
    ]);
    expect(() => beakr.projects.setBoundary(A, {})).toThrow(TypeError);
  });

  it("a boundary below the minimum is typed", async () => {
    const { fetch } = mockFetch([
      refusal(422, "boundary_below_minimum", "Your organization's minimum boundary is locked.", {
        minimum: { content_out: "locked" },
      }),
    ]);
    const error = await client(fetch)
      .beakr.projects.setBoundary(A, { contentOut: "allowed" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BoundaryBelowMinimumError);
    expect((error as BoundaryBelowMinimumError).minimum).toEqual({ content_out: "locked" });
  });
});

describe("the organization's settings", () => {
  it("send the boundaries; a null minimum clears it", async () => {
    const { fetch, calls } = mockFetch([json({}), json({})]);
    const { beakr } = client(fetch);
    await beakr.projectIsolation.update(
      { default_boundary: { content_out: "locked", content_in: "owner_approves" } },
      "org1",
    );
    await beakr.projectIsolation.update({ minimum_boundary: null }, "org1");
    expect(calls.map((c) => c.body)).toEqual([
      { default_boundary: { content_out: "locked", content_in: "owner_approves" } },
      { minimum_boundary: null },
    ]);
  });

  it("a retired setting is a SettingRetiredError", async () => {
    const { fetch } = mockFetch([
      refusal(422, "setting_retired", "cross_project_guard was replaced by project boundaries."),
    ]);
    await expect(
      client(fetch).beakr.projectIsolation.update({ cross_project_guard: "hold" }, "org1"),
    ).rejects.toBeInstanceOf(SettingRetiredError);
  });
});

describe("refusals", () => {
  it("a write carrying a locked project's content is a ProjectContentLockedError", async () => {
    const { fetch } = mockFetch([
      refusal(403, "project_content_locked", "This write brings in content from Partner A.", {
        session_id: "s1",
        project: { id: CHEM, name: "Chemistry" },
        other_projects: [{ id: A, name: "Partner A", via: ["cited"] }],
      }),
    ]);
    const error = await client(fetch)
      .beakr.request({ method: "POST", path: "/v1/knowledge/wiki/proposals", body: {} })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProjectContentLockedError);
    const locked = error as ProjectContentLockedError;
    expect(locked.sessionId).toBe("s1");
    expect(locked.project?.name).toBe("Chemistry");
    expect(locked.otherProjects[0]?.name).toBe("Partner A");
  });
});
