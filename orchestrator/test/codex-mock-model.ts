// Un "modello" locale che parla la Responses API in streaming, per far girare turni veri di
// `codex app-server` senza rete né credenziali (provider configurato con model_providers).
// Ogni richiesta riceve la risposta successiva dello script: una chiamata a un tool o un messaggio.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { onCleanup } from './helpers.js';

export type MockReply = { call: string; args: Record<string, unknown> } | { message: string };

export interface MockModel {
  url: string;
  /** i corpi delle richieste ricevute (JSON) */
  requests: Array<Record<string, any>>;
  /** la configurazione da passare a ogni thread */
  config: Record<string, unknown>;
}

export async function mockModel(script: Array<MockReply | ((req: Record<string, any>) => MockReply)>): Promise<MockModel> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const j = body ? (JSON.parse(body) as Record<string, any>) : {};
      requests.push(j);
      const step = script[Math.min(requests.length - 1, script.length - 1)]!;
      const reply = typeof step === 'function' ? step(j) : step;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (o: Record<string, unknown>) => res.write(`event: ${String(o.type)}\ndata: ${JSON.stringify(o)}\n\n`);
      const id = `resp_${requests.length}`;
      ev({ type: 'response.created', response: { id } });
      if ('call' in reply) ev({ type: 'response.output_item.done', item: { type: 'function_call', id: `fc_${requests.length}`, call_id: `call_${requests.length}`, name: reply.call, arguments: JSON.stringify(reply.args) } });
      else ev({ type: 'response.output_item.done', item: { type: 'message', id: `msg_${requests.length}`, role: 'assistant', content: [{ type: 'output_text', text: reply.message }] } });
      ev({ type: 'response.completed', response: { id, usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 120 } } });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  onCleanup(() => new Promise<void>((r) => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { url, requests, config: { model_providers: { finto: { name: 'finto', base_url: url, wire_api: 'responses', requires_openai_auth: false } }, model_provider: 'finto' } };
}

/** L'output che Codex ha rimandato al modello per la chiamata più recente. */
export function lastToolOutput(req: Record<string, any>): string {
  const items = (req.input ?? []) as Array<Record<string, any>>;
  const out = [...items].reverse().find((i) => i.type === 'function_call_output');
  return typeof out?.output === 'string' ? out.output : JSON.stringify(out?.output ?? '');
}

/** I nomi dei tool offerti al modello (anche quelli dentro i namespace). */
export function toolNames(req: Record<string, any>): string[] {
  const out: string[] = [];
  for (const t of (req.tools ?? []) as Array<Record<string, any>>) {
    if (t.name) out.push(String(t.name));
    else out.push(String(t.type));
    for (const sub of (t.tools ?? []) as Array<Record<string, any>>) out.push(`${t.name}.${sub.name}`);
  }
  return out;
}
