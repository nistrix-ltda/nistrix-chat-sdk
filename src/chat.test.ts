import { describe, expect, it, vi } from "vitest";

import { ChatError, NistrixChat, type ChatMessage } from "./chat.js";

const KEY = "nx_pk_live_abc123";
const API = "https://api.example";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function message(id: string, direction: ChatMessage["direction"], body: string): ChatMessage {
  return { id, direction, kind: "TEXT", body, status: "SENT", sentAt: "2026-12-01T10:00:00Z" };
}

/** A fake API: answers by path, records every call. */
function fakeApi(answers: Record<string, () => Response>, key = KEY) {
  const calls: Call[] = [];
  const fetcher = vi.fn((url: string, init: RequestInit) => {
    const path = url.replace(`${API}/widget/${key}`, "");
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const answer = answers[`${init.method ?? "GET"} ${path}`];
    return Promise.resolve(answer ? answer() : new Response(null, { status: 404 }));
  });
  return { calls, fetch: fetcher as unknown as typeof fetch };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("given a publishable key", () => {
  it("then a secret key is refused before anything is sent", () => {
    expect(() => new NistrixChat({ publishableKey: "nx_sk_live_secret" })).toThrow(
      /publishable key/,
    );
  });

  it("then the visitor's session is started once, kept, and sent with every message", async () => {
    const stored = new Map<string, string>();
    const api = fakeApi({
      "POST /visitors": () => json({ visitorToken: "visitor-1" }),
      "POST /messages": () => json({ items: [message("m1", "INBOUND", "Oi")] }),
      "GET /messages": () => json({ items: [message("m1", "INBOUND", "Oi")] }),
    });
    const chat = new NistrixChat({
      publishableKey: KEY,
      apiUrl: `${API}/`,
      appId: "com.loja.app",
      fetch: api.fetch,
      storage: {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => {
          stored.set(key, value);
        },
      },
    });

    const sent = await chat.send("Oi", { name: "Bia" });
    const history = await chat.messages();

    expect(sent).toEqual(history);
    expect(api.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${API}/widget/${KEY}/visitors`,
      `POST ${API}/widget/${KEY}/messages`,
      `GET ${API}/widget/${KEY}/messages`,
    ]);
    const [, send] = api.calls;
    expect(send?.headers.authorization).toBe("Bearer visitor-1");
    expect(send?.headers["X-Nistrix-App"]).toBe("com.loja.app");
    expect(send?.body).toMatchObject({ body: "Oi", name: "Bia" });
    expect([...stored.values()]).toEqual(["visitor-1"]);
    expect(chat.test).toBe(false);
  });

  it("then an expired session is replaced once and the call retried", async () => {
    let first = true;
    const api = fakeApi({
      "POST /visitors": () => json({ visitorToken: first ? "old" : "new" }),
      "GET /messages": () => {
        if (first) {
          first = false;
          return json({ type: "urn:nistrix:problem:invalid-visitor-token" }, 401);
        }
        return json({ items: [] });
      },
    });
    const chat = new NistrixChat({ publishableKey: KEY, apiUrl: API, fetch: api.fetch });

    await expect(chat.messages()).resolves.toEqual([]);
    expect(api.calls.filter((call) => call.url.endsWith("/visitors"))).toHaveLength(2);
  });

  it("then a site or app the key does not list gets the API's reason", async () => {
    const api = fakeApi({
      "POST /visitors": () => json({ type: "urn:nistrix:problem:origin-not-allowed" }, 403),
    });
    const chat = new NistrixChat({ publishableKey: KEY, apiUrl: API, fetch: api.fetch });

    const failure = await chat.messages().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ChatError);
    expect(failure).toMatchObject({ status: 403, code: "origin-not-allowed" });
  });
});

describe("given a subscription", () => {
  it("then the live connection names the key and app, and new messages refresh the chat", async () => {
    class FakeSocket {
      static opened: FakeSocket[] = [];
      onmessage?: (event: MessageEvent) => void;
      onopen?: () => void;
      onclose?: () => void;
      readonly url: string;
      readonly options: { headers?: Record<string, string> } | undefined;
      constructor(url: string, _protocols?: string, options?: { headers?: Record<string, string> }) {
        this.url = url;
        this.options = options;
        FakeSocket.opened.push(this);
      }
      close(): void {
        // Closed by the chat.
      }
    }
    const api = fakeApi({
      "POST /visitors": () => json({ visitorToken: "visitor-1" }),
      "POST /tickets": () => json({ ticket: "ticket-1", expiresIn: 30 }),
      "GET /messages": () => json({ items: [message("m2", "OUTBOUND", "Olá! Como posso ajudar?")] }),
    }, "nx_pk_test_abc123");
    const chat = new NistrixChat({
      publishableKey: "nx_pk_test_abc123",
      apiUrl: API,
      appId: "com.loja.app",
      fetch: api.fetch,
      WebSocket: FakeSocket as never,
    });
    const received: ChatMessage[][] = [];

    const stop = chat.subscribe((items) => received.push(items));
    await vi.waitFor(() => {
      expect(FakeSocket.opened).toHaveLength(1);
    });
    const [opened] = FakeSocket.opened;
    opened?.onmessage?.({ data: JSON.stringify({ type: "message.created" }) } as MessageEvent);
    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    stop();

    expect(opened?.url).toBe(
      "wss://api.example/widget/realtime?ticket=ticket-1&key=nx_pk_test_abc123&app=com.loja.app",
    );
    expect(opened?.options?.headers).toEqual({ "X-Nistrix-App": "com.loja.app" });
    expect(received[0]?.[0]?.body).toBe("Olá! Como posso ajudar?");
    expect(chat.test).toBe(true);
  });
});
