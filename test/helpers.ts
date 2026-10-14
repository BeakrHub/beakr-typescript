import { Beakr, type ClientOptions } from "../src/index.js";

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = Response | ((call: Recorded) => Response) | Error;

/** A fetch that answers from a queue of replies and records every request. */
export function mockFetch(replies: Reply[]) {
  const calls: Recorded[] = [];
  const queue = [...replies];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: Recorded = {
      url,
      method: String(init.method),
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    };
    calls.push(call);
    const reply = queue.shift();
    if (reply === undefined) throw new Error(`unexpected request ${call.method} ${url}`);
    if (reply instanceof Error) throw reply;
    return typeof reply === "function" ? reply(call) : reply;
  };
  return { fetch, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function client(fetch: ClientOptions["fetch"], options: ClientOptions = {}) {
  const sleeps: number[] = [];
  const beakr = new Beakr({
    apiKey: "bk_live_test",
    baseUrl: "https://api.example.test",
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
  });
  return { beakr, sleeps };
}
