/**
 * Sessions: a client confined to the projects a person chooses, whose token is
 * minted again with the person's own credential before it expires.
 */
import { describe, expect, it } from "vitest";
import {
  Beakr,
  SessionNeedsSelectionError,
  SessionWidenRefusedError,
  SessionWriteScopeError,
} from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const BASE = "https://api.example.test";

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function session(extra: Record<string, unknown> = {}) {
  return {
    id: "s1",
    status: "active",
    client_name: "sdk-typescript",
    picker_url: "https://app.test/sessions/s1",
    read_projects: [{ id: "p1", name: "Docs" }],
    write_projects: [],
    run_label: "session:s1",
    ...extra,
  };
}

function created(token = "bk_st_first", expiresInMs = 3_600_000) {
  return session({ token: { token, token_type: "bearer", expires_at: iso(expiresInMs) } });
}

function refusal(code: string, details: Record<string, unknown> = {}) {
  return json(
    {
      detail: { code, message: `${code} message`, ...details },
      error: { code, message: `${code} message`, details },
    },
    403,
  );
}

describe("sessions", () => {
  it("creates a session and hands back a client that sends its token", async () => {
    const { fetch, calls } = mockFetch([json(created(), 201), json({ id: "u1" })]);
    const { beakr } = client(fetch);
    const scoped = await beakr.sessions.create({ read: ["p1", "p2"], write: ["p2"], label: "nightly" });
    await scoped.client.me.get();
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${BASE}/v1/sessions`);
    expect(calls[0]!.body).toEqual({
      client_name: "sdk-typescript",
      label: "nightly",
      read_project_ids: ["p1", "p2"],
      write_project_ids: ["p2"],
      issue_token: true,
    });
    // A retried create would start a second session.
    expect(calls[0]!.headers["idempotency-key"]).toBeUndefined();
    expect(calls[1]!.headers["authorization"]).toBe("Bearer bk_st_first");
    expect(scoped.client).toBeInstanceOf(Beakr);
    expect(scoped.id).toBe("s1");
    expect(scoped.pickerUrl).toBe("https://app.test/sessions/s1");
    expect("token" in scoped.session).toBe(false);
  });

  it("reads the projects it writes when given only write", async () => {
    const { fetch, calls } = mockFetch([json(created(), 201)]);
    const { beakr } = client(fetch);
    await beakr.sessions.create({ write: ["p2"] });
    expect(calls[0]!.body).toMatchObject({ read_project_ids: ["p2"], write_project_ids: ["p2"] });
  });

  it("mints a new token with the person's credential before the old one expires", async () => {
    const { fetch, calls } = mockFetch([
      json(created("bk_st_first", 5_000), 201),
      json({ token: "bk_st_second", token_type: "bearer", expires_at: iso(3_600_000) }, 201),
      json({ id: "u1" }),
      json({ id: "u1" }),
    ]);
    const { beakr } = client(fetch);
    const scoped = await beakr.sessions.create({ read: ["p1"], ttlSeconds: 600 });
    await scoped.client.me.get();
    await scoped.client.me.get();
    expect(calls[1]!.url).toBe(`${BASE}/v1/sessions/s1/tokens`);
    expect(calls[1]!.headers["authorization"]).toBe("Bearer bk_live_test");
    expect(calls[1]!.body).toEqual({ ttl_seconds: 600 });
    expect(calls.slice(2).map((c) => c.headers["authorization"])).toEqual([
      "Bearer bk_st_second",
      "Bearer bk_st_second",
    ]);
  });

  it("renews once on a 401 and resends", async () => {
    const { fetch, calls } = mockFetch([
      json(created(), 201),
      json({ detail: "expired" }, 401),
      json({ token: "bk_st_second", expires_at: iso(3_600_000) }, 201),
      json({ id: "u1" }),
    ]);
    const { beakr } = client(fetch);
    const scoped = await beakr.sessions.create({ read: ["p1"] });
    await scoped.client.me.get();
    expect(calls.filter((c) => c.url === `${BASE}/v1/me`).map((c) => c.headers["authorization"])).toEqual([
      "Bearer bk_st_first",
      "Bearer bk_st_second",
    ]);
  });

  it("types the session refusals and carries the picker", async () => {
    const picker = "https://app.test/sessions/s1";
    const { fetch } = mockFetch([
      json(created(), 201),
      refusal("session_needs_selection", { picker_url: picker }),
      refusal("session_write_scope", { picker_url: picker, write_project_ids: ["p2"] }),
      refusal("session_widen_refused"),
    ]);
    const { beakr } = client(fetch);
    const scoped = await beakr.sessions.create();
    const pending = await scoped.client.me.get().catch((e: unknown) => e);
    expect(pending).toBeInstanceOf(SessionNeedsSelectionError);
    expect((pending as SessionNeedsSelectionError).pickerUrl).toBe(picker);
    const write = await scoped.client
      .request({ method: "POST", path: "/v1/folders", body: { name: "x", project_id: "p1" } })
      .catch((e: unknown) => e);
    expect(write).toBeInstanceOf(SessionWriteScopeError);
    expect((write as SessionWriteScopeError).writeProjectIds).toEqual(["p2"]);
    await expect(scoped.client.sessions.update("s1", { read: ["p1", "p9"] })).rejects.toBeInstanceOf(
      SessionWidenRefusedError,
    );
  });

  it("wraps an existing session", async () => {
    const { fetch, calls } = mockFetch([
      json({ token: "bk_st_x", expires_at: iso(3_600_000) }, 201),
      json(session()),
      json({ id: "u1" }),
    ]);
    const { beakr } = client(fetch);
    const scoped = await beakr.sessions.scoped("s1");
    await scoped.client.me.get();
    expect(calls[2]!.headers["authorization"]).toBe("Bearer bk_st_x");
  });

  it("sends update, end, list and current", async () => {
    const { fetch, calls } = mockFetch([
      json(session()),
      json(session({ status: "ended" })),
      json({ data: [session()], has_more: false, next_cursor: null }),
      json(session()),
    ]);
    const { beakr } = client(fetch);
    await beakr.sessions.update("s1", { read: ["p1"], write: [], rememberFolder: true });
    await beakr.sessions.end("s1");
    await beakr.sessions.list({ includeEnded: true });
    await beakr.sessions.current();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `PATCH ${BASE}/v1/sessions/s1`,
      `POST ${BASE}/v1/sessions/s1/end`,
      `GET ${BASE}/v1/sessions?include_ended=true`,
      `GET ${BASE}/v1/sessions/current`,
    ]);
    expect(calls[0]!.body).toEqual({ read_project_ids: ["p1"], write_project_ids: [], remember_folder: true });
  });
});
