import { expect, it } from "vitest";
import { Beakr } from "../src/index.js";

// Construct an actual Fetch Request so WHATWG dot-path normalization is visible.
// No network is used; every attempted request receives an in-memory response.
it.each([".", "..", ""])("rejects generated project path value %j before fetch", async (id) => {
  const paths: string[] = [];
  const beakr = new Beakr({
    apiKey: "bk_test_fixture",
    baseUrl: "https://api.example.test",
    fetch: async (url, init) => {
      paths.push(new URL(new Request(url, init).url).pathname);
      return Response.json({ id: "unexpected" });
    },
  });
  let error: unknown;
  try {
    await beakr.api.projects.getProject({ path: { project_id: id } });
  } catch (caught) {
    error = caught;
  }
  expect(paths, "invalid IDs must not select another HTTP route").toEqual([]);
  expect(error).toBeInstanceOf(Error);
});

it.each([".", "..", ""])("rejects helper project path value %j before fetch", async (id) => {
  const paths: string[] = [];
  const beakr = new Beakr({
    apiKey: "bk_test_fixture",
    baseUrl: "https://api.example.test",
    fetch: async (url, init) => {
      paths.push(new URL(new Request(url, init).url).pathname);
      return Response.json({ id: "unexpected" });
    },
  });
  let error: unknown;
  try {
    await beakr.projects.get(id);
  } catch (caught) {
    error = caught;
  }
  expect(paths, "invalid IDs must not select another HTTP route").toEqual([]);
  expect(error).toBeInstanceOf(Error);
});
