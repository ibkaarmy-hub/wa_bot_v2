import type { MessagingPort } from "../../core/ports.js";

export class MetaSendError extends Error {
  constructor(public status: number, public body: string) {
    super(`Meta send failed: HTTP ${status} ${body.slice(0, 200)}`);
  }
  get retryable() { return this.status === 0 || this.status === 429 || this.status >= 500; }
}

export class MetaMessaging implements MessagingPort {
  private fetchImpl: typeof fetch;
  private base: string;
  private lang: string;
  constructor(private opts: { accessToken: string; phoneNumberId: string; fetchImpl?: typeof fetch; graphVersion?: string; languageCode?: string; baseUrl?: string }) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    const host = (opts.baseUrl ?? "https://graph.facebook.com").replace(/\/+$/, "");
    this.base = `${host}/${opts.graphVersion ?? "v21.0"}/${opts.phoneNumberId}/messages`;
    this.lang = opts.languageCode ?? "en";
  }

  private async post(payload: unknown): Promise<{ id: string }> {
    let res: Response;
    try { res = await this.fetchImpl(this.base, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }); }
    catch (e) { throw new MetaSendError(0, `network error: ${(e as Error).message}`); }
    let text: string;
    try { text = await res.text(); }
    catch (e) { throw new MetaSendError(0, `body read error: ${(e as Error).message}`); }
    if (!res.ok) throw new MetaSendError(res.status, text);
    let json: { messages?: Array<{ id: string }> };
    try { json = JSON.parse(text); } catch { throw new MetaSendError(res.status, `non-JSON response body: ${text.slice(0, 200)}`); }
    const id = json.messages?.[0]?.id;
    if (!id) throw new MetaSendError(res.status, `no message id in response: ${text}`);
    return { id };
  }

  private static digits(phone: string) { return phone.replace(/[^\d]/g, ""); }

  sendText(to: string, body: string) {
    return this.post({ messaging_product: "whatsapp", recipient_type: "individual", to: MetaMessaging.digits(to), type: "text", text: { preview_url: false, body } });
  }

  sendTemplate(to: string, template: string, params: string[]) {
    return this.post({
      messaging_product: "whatsapp", to: MetaMessaging.digits(to), type: "template",
      template: { name: template, language: { code: this.lang }, components: [{ type: "body", parameters: params.map(text => ({ type: "text", text })) }] },
    });
  }
}
