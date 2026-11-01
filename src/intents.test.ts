import { describe, expect, it, vi } from "vitest";

import { ChatError } from "./chat.js";
import { NistrixIntents } from "./intents.js";

const KEY = "nx_pk_test_abc123";
const API = "https://api.example";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeApi(answer: (path: string, init: RequestInit) => Response) {
  const calls: { path: string; init: RequestInit }[] = [];
  const fetcher = vi.fn((url: string, init: RequestInit) => {
    const path = url.replace(`${API}/widget/${KEY}`, "");
    calls.push({ path, init });
    return Promise.resolve(answer(path, init));
  });
  return { calls, fetch: fetcher as unknown as typeof fetch };
}

describe("given a booking page", () => {
  it("then slots are asked with the query and a booking is sent as an intent", async () => {
    const api = fakeApi((path) =>
      path.startsWith("/slots")
        ? json({ items: [{ localStart: "2026-12-08 09:00" }] })
        : json({ id: "nx_int_1", type: "book_appointment", status: "pending", test: true }, 201),
    );
    const nistrix = new NistrixIntents({
      publishableKey: KEY,
      apiUrl: API,
      appId: "com.loja.app",
      fetch: api.fetch,
    });

    const [slot] = await nistrix.slots({ service: "Limpeza", from: "2026-12-08" });
    const intent = await nistrix.book({
      service: "Limpeza",
      start: slot?.localStart ?? "",
      name: "Bia",
      phone: "92991234567",
    });

    expect(nistrix.test).toBe(true);
    expect(api.calls[0]?.path).toBe("/slots?service=Limpeza&from=2026-12-08");
    expect(api.calls[1]?.init.method).toBe("POST");
    expect(JSON.parse(String(api.calls[1]?.init.body))).toMatchObject({
      type: "book_appointment",
      start: "2026-12-08 09:00",
    });
    expect((api.calls[1]?.init.headers as Record<string, string>)["X-Nistrix-App"]).toBe(
      "com.loja.app",
    );
    expect(intent.status).toBe("pending");
  });

  it("then a time just taken comes back as a ChatError with its code", async () => {
    const api = fakeApi(() =>
      json({ type: "urn:nistrix:problem:intent-refused", status: 409 }, 409),
    );
    const nistrix = new NistrixIntents({ publishableKey: KEY, apiUrl: API, fetch: api.fetch });

    const refused = await nistrix
      .book({ start: "2026-12-08 09:00", name: "Bia", phone: "92991234567" })
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ChatError);
    expect((refused as ChatError).code).toBe("intent-refused");
  });
});

describe("given a lead form", () => {
  it("then a CPF is tokenized and the token goes in the lead's fields", async () => {
    const api = fakeApi((path) =>
      path === "/tokens"
        ? json({ token: "nx_tok_1", kind: "cpf", hint: "…25" }, 201)
        : json({ id: "nx_int_2", type: "submit_lead", status: "confirmed" }, 201),
    );
    const nistrix = new NistrixIntents({ publishableKey: KEY, apiUrl: API, fetch: api.fetch });

    const cpf = await nistrix.tokenize("cpf", "529.982.247-25");
    await nistrix.submitLead({ phone: "92991234567", fields: { cpf: cpf.token } });

    expect(JSON.parse(String(api.calls[1]?.init.body))).toEqual({
      type: "submit_lead",
      phone: "92991234567",
      fields: { cpf: "nx_tok_1" },
    });
  });

  it("then a secret key is refused", () => {
    expect(() => new NistrixIntents({ publishableKey: "nx_sk_live_x" })).toThrow(/publishable/);
  });
});

describe("given a support form", () => {
  it("then a ticket is sent as an open_ticket intent", async () => {
    const api = fakeApi(() => json({ id: "nx_int_3", type: "open_ticket", status: "pending" }, 201));
    const nistrix = new NistrixIntents({ publishableKey: KEY, apiUrl: API, fetch: api.fetch });

    await nistrix.openTicket({ subject: "Pedido atrasado", phone: "92991234567" });

    expect(JSON.parse(String(api.calls[0]?.init.body))).toEqual({
      type: "open_ticket",
      subject: "Pedido atrasado",
      phone: "92991234567",
    });
  });
});
