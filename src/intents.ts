/**
 * Booking pages and lead forms in customers' sites and apps, with the same publishable key as
 * the chat. Free times are public; a booking, a lead, or a ticket is an intent (nx_int_, ten minutes) that
 * the organization's backend confirms with a secret key, unless the key confirms it on its own.
 * Sensitive values (a CPF, a health note) become data tokens (nx_tok_) sent in their place.
 */

import { ChatError, DEFAULT_API_URL } from "./chat.js";

const APP_HEADER = "X-Nistrix-App";

export interface NistrixIntentsOptions {
  /** The organization's publishable key: nx_pk_live_... or, in its sandbox, nx_pk_test_.... */
  publishableKey: string;
  apiUrl?: string;
  /** Native apps only: the bundle id or package name listed on the key. */
  appId?: string;
  fetch?: typeof fetch;
}

export interface BookingOptions {
  schedules: { id: string; name: string; timezone: string }[];
  services: { name: string; durationMinutes: number | null; price: string | null }[];
}

export interface Slot {
  scheduleId: string;
  scheduleName: string;
  startsAt: string;
  /** YYYY-MM-DD HH:MM in the schedule's zone: send it back as `start`. */
  localStart: string;
  timezone: string;
}

export type IntentType = "book_appointment" | "submit_lead" | "open_ticket";
export type IntentStatus = "pending" | "confirmed" | "failed" | "expired";

export interface Intent {
  /** nx_int_...: hand it to your backend, which confirms it. */
  id: string;
  type: IntentType;
  status: IntentStatus;
  /** True for a sandbox key: nothing here reaches real customers. */
  test: boolean;
  expiresAt: string;
  /** For a booking: scheduleName, serviceName, localStart, timezone; for a ticket: number. */
  result: Record<string, unknown> | null;
  error: string | null;
}

export interface BookingRequest {
  scheduleId?: string;
  service?: string;
  /** YYYY-MM-DD HH:MM in the schedule's zone (a slot's `localStart`). */
  start: string;
  name: string;
  phone: string;
  email?: string;
  notes?: string;
}

export type FieldValue = string | number | boolean | null;

export interface LeadRequest {
  name?: string;
  phone: string;
  email?: string;
  message?: string;
  /** Customer fields by key; a sensitive value goes as its data token. */
  fields?: Record<string, FieldValue>;
}

export interface TicketRequest {
  subject: string;
  description?: string;
  category?: string;
  name?: string;
  phone: string;
  email?: string;
}

export type DataKind = "cpf" | "cnpj" | "text";

export interface DataToken {
  /** nx_tok_...: send it in place of the value. */
  token: string;
  kind: DataKind;
  /** The last digits of a document; empty for text. */
  hint: string;
  expiresAt: string;
}

export class NistrixIntents {
  readonly #base: string;
  readonly #key: string;
  readonly #appId: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: NistrixIntentsOptions) {
    if (!options.publishableKey.startsWith("nx_pk_")) {
      throw new Error("Use a publishable key (nx_pk_...); never a secret key in an app.");
    }
    const apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
    this.#key = options.publishableKey;
    this.#base = `${apiUrl}/widget/${encodeURIComponent(this.#key)}`;
    this.#appId = options.appId;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** True for a sandbox key: nothing here reaches real customers. */
  get test(): boolean {
    return this.#key.startsWith("nx_pk_test_");
  }

  async #request<T>(path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.#appId) {
      headers[APP_HEADER] = this.#appId;
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const response = await this.#fetch(`${this.#base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

  /** The schedules open for booking and the services they offer. */
  async bookingOptions(): Promise<BookingOptions> {
    return this.#request("/booking");
  }

  /** Free times, a week from `from` (YYYY-MM-DD) by default. */
  async slots(
    query: { scheduleId?: string; service?: string; from?: string; to?: string } = {},
  ): Promise<Slot[]> {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value) {
        params.set(name, value);
      }
    }
    const search = params.size ? `?${params.toString()}` : "";
    const { items } = await this.#request<{ items: Slot[] }>(`/slots${search}`);
    return items;
  }

  /** Asks for an appointment. Refused (ChatError 409, intent-refused) when the key confirms
   * bookings on its own and the time was just taken. */
  async book(booking: BookingRequest): Promise<Intent> {
    return this.#request("/intents", { type: "book_appointment", ...booking });
  }

  /** Sends a lead from a form. */
  async submitLead(lead: LeadRequest): Promise<Intent> {
    return this.#request("/intents", { type: "submit_lead", ...lead });
  }

  /** Opens a support ticket (the customer is found or created by phone). */
  async openTicket(ticket: TicketRequest): Promise<Intent> {
    return this.#request("/intents", { type: "open_ticket", ...ticket });
  }

  /** Where an intent stands: pending, confirmed, failed (with the reason), or expired. */
  async intent(id: string): Promise<Intent> {
    return this.#request(`/intents/${encodeURIComponent(id)}`);
  }

  /** Keeps a sensitive value and returns a token for it (valid for a day, used once). */
  async tokenize(kind: DataKind, value: string): Promise<DataToken> {
    return this.#request("/tokens", { kind, value });
  }
}
