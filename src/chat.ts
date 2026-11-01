/**
 * The Nistrix chat for customers' sites and apps. A publishable key (nx_pk_) opens visitor
 * chats on one of the organization's chat channels, from the sites and apps listed on the key:
 * browsers are recognized by their origin, native apps by `appId` (their bundle id or package
 * name). The key is not a secret and can do nothing else.
 */

export const DEFAULT_API_URL = "https://api.nistrix.com";
const APP_HEADER = "X-Nistrix-App";
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

export interface ChatAttachment {
  /** Opens the file for a few minutes; a new link comes with every refresh. */
  url: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface ChatMessage {
  id: string;
  /** INBOUND: written by the visitor; OUTBOUND: by the agent or the team. */
  direction: "INBOUND" | "OUTBOUND";
  kind: string;
  body: string | null;
  status: string;
  sentAt: string;
  attachment?: ChatAttachment | null;
}

/** Where the visitor's session is kept between visits (localStorage, AsyncStorage, ...). */
export interface VisitorStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
}

export interface NistrixChatOptions {
  /** The organization's publishable key: nx_pk_live_... or, in its sandbox, nx_pk_test_.... */
  publishableKey: string;
  apiUrl?: string;
  /** Native apps only: the bundle id or package name listed on the key. */
  appId?: string;
  /** Keeps the visitor's session; in memory when left out (a new visitor every launch). */
  storage?: VisitorStorage;
  fetch?: typeof fetch;
  /** The WebSocket class; React Native's accepts headers, which native apps need. */
  WebSocket?: WebSocketFactory;
}

export type WebSocketFactory = new (
  url: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> },
) => WebSocket;

export class ChatError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null) {
    super(`Nistrix chat request failed (${String(status)}${code ? `, ${code}` : ""}).`);
    this.name = "ChatError";
    this.status = status;
    this.code = code;
  }
}

class MemoryStorage implements VisitorStorage {
  readonly #items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
}

function newId(): string {
  return globalThis.crypto.randomUUID();
}

export class NistrixChat {
  readonly #base: string;
  readonly #apiUrl: string;
  readonly #key: string;
  readonly #appId: string | undefined;
  readonly #storage: VisitorStorage;
  readonly #fetch: typeof fetch;
  readonly #WebSocket: WebSocketFactory | undefined;
  #token: string | null = null;
  #socket: WebSocket | null = null;
  #listeners = new Set<(messages: ChatMessage[]) => void>();
  #retryMs = FIRST_RETRY_MS;
  #closed = false;

  constructor(options: NistrixChatOptions) {
    if (!options.publishableKey.startsWith("nx_pk_")) {
      throw new Error("Use a publishable key (nx_pk_...); never a secret key in an app.");
    }
    this.#apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
    this.#key = options.publishableKey;
    this.#base = `${this.#apiUrl}/widget/${encodeURIComponent(this.#key)}`;
    this.#appId = options.appId;
    this.#storage = options.storage ?? new MemoryStorage();
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#WebSocket = options.WebSocket ?? (globalThis.WebSocket as WebSocketFactory | undefined);
  }

  /** True for a sandbox key: nothing here reaches real customers. */
  get test(): boolean {
    return this.#key.startsWith("nx_pk_test_");
  }

  get #storageKey(): string {
    return `nistrix-chat:${this.#key}:visitor`;
  }

  get #headers(): Record<string, string> {
    return this.#appId ? { [APP_HEADER]: this.#appId } : {};
  }

  async #request<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean }) {
    const headers: Record<string, string> = { ...this.#headers, accept: "application/json" };
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (init.auth) {
      headers.authorization = `Bearer ${await this.#session()}`;
    }
    const response = await this.#fetch(`${this.#base}${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!response.ok) {
      let code: string | null = null;
      try {
        const problem = (await response.json()) as { type?: string };
        code = problem.type?.split(":").pop() ?? null;
      } catch {
        // Not a problem document.
      }
      throw new ChatError(response.status, code);
    }
    return (await response.json()) as T;
  }

  async #session(forceNew = false): Promise<string> {
    if (this.#token && !forceNew) {
      return this.#token;
    }
    const stored = forceNew ? null : await this.#storage.getItem(this.#storageKey);
    const { visitorToken } = await this.#request<{ visitorToken: string }>("/visitors", {
      method: "POST",
      body: { visitorToken: stored },
    });
    this.#token = visitorToken;
    await this.#storage.setItem(this.#storageKey, visitorToken);
    return visitorToken;
  }

  /** Runs a call as the visitor, starting a new session once if the old one expired. */
  async #asVisitor<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    try {
      return await this.#request<T>(path, { ...init, auth: true });
    } catch (error) {
      if (!(error instanceof ChatError) || error.status !== 401) {
        throw error;
      }
      await this.#session(true);
      return this.#request<T>(path, { ...init, auth: true });
    }
  }

  /** The chat's name and greeting, and whether the organization is available. */
  async config(): Promise<{ name: string; greeting: string | null; available: boolean }> {
    return this.#request("", {});
  }

  /** The visitor's conversation so far, oldest first. */
  async messages(): Promise<ChatMessage[]> {
    const { items } = await this.#asVisitor<{ items: ChatMessage[] }>("/messages");
    return items;
  }

  /** Sends what the visitor wrote; `name` tells the team who is writing. Returns the chat. */
  async send(body: string, options: { name?: string } = {}): Promise<ChatMessage[]> {
    const { items } = await this.#asVisitor<{ items: ChatMessage[] }>("/messages", {
      method: "POST",
      body: { body, clientMessageId: newId(), name: options.name ?? null },
    });
    this.#emit(items);
    return items;
  }

  /** Calls `listener` with the whole chat whenever the agent or the team writes. */
  subscribe(listener: (messages: ChatMessage[]) => void): () => void {
    this.#listeners.add(listener);
    this.#closed = false;
    if (!this.#socket) {
      void this.#connect();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.close();
      }
    };
  }

  /** Stops listening; the visitor's session stays for the next visit. */
  close(): void {
    this.#closed = true;
    this.#socket?.close();
    this.#socket = null;
  }

  #emit(messages: ChatMessage[]): void {
    for (const listener of this.#listeners) {
      listener(messages);
    }
  }

  async #connect(): Promise<void> {
    if (!this.#WebSocket || this.#closed) {
      return;
    }
    try {
      const { ticket } = await this.#asVisitor<{ ticket: string }>("/tickets", { method: "POST" });
      const url = new URL("/widget/realtime", this.#apiUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ticket", ticket);
      url.searchParams.set("key", this.#key);
      if (this.#appId) {
        // Not every WebSocket can send headers (browsers', Node's): the app is named here too.
        url.searchParams.set("app", this.#appId);
      }
      // Browsers send their origin themselves; native apps name themselves in a header.
      const socket = this.#appId
        ? new this.#WebSocket(url.toString(), undefined, { headers: this.#headers })
        : new this.#WebSocket(url.toString());
      this.#socket = socket;
      socket.onopen = () => {
        this.#retryMs = FIRST_RETRY_MS;
      };
      socket.onmessage = (event: MessageEvent) => {
        const data = JSON.parse(String(event.data)) as { type?: string };
        if (data.type !== "ping") {
          void this.messages().then((items) => {
            this.#emit(items);
          });
        }
      };
      socket.onclose = () => {
        this.#socket = null;
        this.#reconnect();
      };
    } catch {
      this.#reconnect();
    }
  }

  #reconnect(): void {
    if (this.#closed || this.#listeners.size === 0) {
      return;
    }
    const wait = this.#retryMs;
    this.#retryMs = Math.min(this.#retryMs * 2, MAX_RETRY_MS);
    setTimeout(() => {
      void this.#connect();
    }, wait);
  }
}
