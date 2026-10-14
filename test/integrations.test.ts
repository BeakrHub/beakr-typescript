import { describe, expect, it } from "vitest";
import { client, json, mockFetch } from "./helpers.js";

const path = (url: string) => url.replace("https://api.example.test", "");

describe("integrations", () => {
  it("connects through a browser link with the chosen scope", async () => {
    const { fetch, calls } = mockFetch([json({ connect_url: "https://connect.example/x" })]);
    const { beakr } = client(fetch);
    const link = await beakr.integrations.connect("slack", { scope: "org" });
    expect(link.connect_url).toBe("https://connect.example/x");
    expect(path(calls[0]!.url)).toBe("/v1/integrations/slack/connect");
    expect(calls[0]!.body).toEqual({ scope: "org" });
  });

  it("reads list and status, and disconnects", async () => {
    const { fetch, calls } = mockFetch([json({ data: [] }), json({ id: "c1" }), json({ ok: true })]);
    const { beakr } = client(fetch);
    await beakr.integrations.list();
    await beakr.integrations.status("c1");
    await beakr.integrations.disconnect("c1");
    expect(calls.map((c) => `${c.method} ${path(c.url)}`)).toEqual([
      "GET /v1/integrations",
      "GET /v1/integrations/c1/status",
      "DELETE /v1/integrations/c1",
    ]);
  });
});
