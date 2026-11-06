// Запускает настоящую Edge Function локально: запросы к соцсетям уходят в заглушку.
const [fn, port] = Deno.args;
const MOCK = Deno.env.get("MOCK_PLATFORMS_URL")!;
const HOSTS = ["api.telegram.org", "graph.instagram.com", "graph.facebook.com", "chatapi.viber.com", "api.vk.com"];

const realFetch = globalThis.fetch;
globalThis.fetch = (input: Request | URL | string, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (HOSTS.includes(url.hostname)) {
    const headers = new Headers(init?.headers);
    headers.set("x-mock-host", url.hostname);
    return realFetch(`${MOCK}${url.pathname}${url.search}`, { ...init, headers });
  }
  return realFetch(input, init);
};

const realServe = Deno.serve.bind(Deno);
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (handler: Deno.ServeHandler) =>
  realServe({ port: Number(port), hostname: "127.0.0.1", onListen: () => {} }, handler);

await import(new URL(`../../supabase/functions/${fn}/index.ts`, import.meta.url).href);
