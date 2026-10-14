/**
 * Pi Durable harness (`PiHarness`) in a Cloudflare Durable Object,
 * with models served by Cloudflare AI Gateway instead of Workers AI.
 *
 * Reference: https://developers.cloudflare.com/agents/harnesses/pi/
 *
 * Deployment-specific values (the gateway URL and the model catalog) are
 * configuration, not code: they come from the worker's environment, so this
 * repository carries no account, domain, or model names of any deployment.
 */
import { Agent } from "agents";
import { PiHarness } from "agents/harness/pi";
import type { Model } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createRegistry, Harness } from "@earendil-works/pi-durable";

interface Env {
  /** Base URL of the gateway that serves the models, e.g. an AI Gateway custom domain. */
  CF_GATEWAY_URL: string;
  /** JSON array of model specs (see `ModelSpec`) exposed by this worker. */
  PI_MODELS: string;
  /** Default model id. Defaults to the first entry of `PI_MODELS`. */
  PI_MODEL?: string;
  /** Gateway token, sent as `cf-aig-authorization`. Set with `wrangler secret put`. */
  CLOUDFLARE_GATEWAY_TOKEN: string;
  /** Optional Cloudflare Access service token, for gateways whose providers sit behind Access. */
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  Assistant: DurableObjectNamespace<Assistant>;
}

/** One entry of `PI_MODELS`. Only `id` is required. */
interface ModelSpec {
  id: string;
  name?: string;
  /** Path under `CF_GATEWAY_URL`, or an absolute URL. Default `/compat`. */
  path?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  /** Passed through to Pi AI's OpenAI-completions compatibility overrides. */
  compat?: Model<"openai-completions">["compat"];
  /** Passed through to Pi AI's thinking-level mapping. */
  thinkingLevelMap?: Model<"openai-completions">["thinkingLevelMap"];
}

const PROVIDER_ID = "gateway";
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const SYSTEM_PROMPT = [
  "You are a practical assistant running as a durable agent on Cloudflare.",
  "Answer in the language the user writes in. Be concise.",
].join("\n");

function parseModels(env: Env): ModelSpec[] {
  let specs: unknown;
  try {
    specs = JSON.parse(env.PI_MODELS);
  } catch (error) {
    throw new Error(`PI_MODELS is not valid JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error("PI_MODELS must be a non-empty JSON array");
  }
  return specs as ModelSpec[];
}

function modelUrl(env: Env, spec: ModelSpec): string {
  const path = spec.path ?? "/compat";
  if (/^https?:\/\//.test(path)) return path;
  return `${env.CF_GATEWAY_URL.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function toModel(env: Env, spec: ModelSpec): Model<"openai-completions"> {
  return {
    id: spec.id,
    name: spec.name ?? spec.id,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: modelUrl(env, spec),
    reasoning: spec.reasoning ?? false,
    input: ["text"],
    cost: NO_COST,
    contextWindow: spec.contextWindow ?? 128_000,
    maxTokens: spec.maxTokens ?? 8_192,
    ...(spec.compat ? { compat: spec.compat } : {}),
    ...(spec.thinkingLevelMap ? { thinkingLevelMap: spec.thinkingLevelMap } : {}),
  };
}

/**
 * A Pi AI provider whose upstream is an AI Gateway. The worker holds only the
 * gateway token; provider keys stay on the gateway (BYOK).
 */
function gatewayProvider(env: Env) {
  const headers: Record<string, string> = {
    "cf-aig-authorization": env.CLOUDFLARE_GATEWAY_TOKEN,
    "cf-aig-collect-log-payload": "false",
  };
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
  }

  return createProvider({
    id: PROVIDER_ID,
    name: "AI Gateway",
    baseUrl: env.CF_GATEWAY_URL,
    headers,
    auth: {
      apiKey: {
        name: "AI Gateway token",
        async resolve() {
          return { auth: { apiKey: env.CLOUDFLARE_GATEWAY_TOKEN, headers } };
        },
      },
    },
    models: parseModels(env).map((spec) => toModel(env, spec)),
    api: openAICompletionsApi(),
  });
}

function defaultModelId(env: Env): string {
  return env.PI_MODEL?.trim() || parseModels(env)[0].id;
}

export class Assistant extends Agent<Env> {
  registry = createRegistry();

  harness = new PiHarness({
    harness: ({ storage, context }) => {
      const models = createModels();
      models.setProvider(gatewayProvider(this.env));
      return Harness.open(storage, { models, registry: this.registry }, context);
    },
    defaults: { model: { provider: PROVIDER_ID, id: defaultModelId(this.env) } },
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.harness);
    this.registry.install({
      name: "pi-harness",
      sections: [{ key: "preamble", render: () => SYSTEM_PROMPT, tag: false }],
    });
  }

  /** Submit a prompt to the session and wait for the answer. */
  async ask(prompt: string, model?: string) {
    const session = this.harness.session();
    const wanted = model?.trim();
    if (wanted && wanted !== defaultModelId(this.env)) {
      const models = createModels();
      models.setProvider(gatewayProvider(this.env));
      const resolved = models.getModel(PROVIDER_ID, wanted);
      if (!resolved) {
        return { status: "unanswered" as const, text: undefined, reason: undefined, error: `unknown model: ${wanted}` };
      }
      await session.setModel(resolved);
    }
    const { text, status, reason } = await this.harness.prompt(prompt);
    return { status, text, reason, error: undefined };
  }

  /** Configured models, for clients that need the catalog. */
  models() {
    return parseModels(this.env).map((spec) => ({ id: spec.id, name: spec.name ?? spec.id }));
  }

  /** Live state of this conversation, useful for debugging a deployment. */
  async agentInfo() {
    const session = this.harness.session();
    const [busy, messages] = await Promise.all([session.busy(), session.messages()]);
    return { id: session.id, busy, entries: messages.length };
  }
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Pi on Cloudflare</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
 textarea,select,input{font:inherit;padding:.6rem;width:100%;box-sizing:border-box}
 textarea{min-height:4rem}
 button{font:inherit;padding:.5rem 1rem;margin-top:.6rem}
 pre{background:#f4f4f5;padding:.8rem;white-space:pre-wrap;word-break:break-word}
 .muted{color:#666;font-size:.9rem}
 label{display:block;margin:.6rem 0 .2rem;font-size:.9rem;color:#444}
</style></head><body>
<h1>Pi Durable on Cloudflare</h1>
<p class="muted">The Pi harness runs in a Durable Object: transcript, tasks and inbox live in the object's SQLite
database. Models are served by AI Gateway, not Workers AI.</p>
<label for="m">model</label>
<select id="m"></select>
<label for="p">prompt</label>
<textarea id="p">Explain in three sentences what Pi Durable is.</textarea><br>
<button id="go">Ask</button>
<p class="muted" id="status"></p>
<pre id="out">(answer appears here)</pre>
<script>
const out=document.getElementById('out'),st=document.getElementById('status'),sel=document.getElementById('m');
fetch('api/models').then(r=>r.json()).then(j=>{
  for(const m of j.models){const o=document.createElement('option');o.value=m.id;o.textContent=m.name||m.id;sel.appendChild(o);}
  if(j.default)sel.value=j.default;
});
document.getElementById('go').onclick=async()=>{
  const prompt=document.getElementById('p').value, model=sel.value;
  st.textContent='running…'; out.textContent='';
  const t=Date.now();
  try{
    const r=await fetch('api/ask',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt,model})});
    const j=await r.json();
    out.textContent=j.text||JSON.stringify(j,null,2);
    st.textContent='model='+model+' · status='+(j.status||'?')+' · '+((Date.now()-t)/1000).toFixed(1)+'s · session='+j.session;
  }catch(e){out.textContent='error: '+e; st.textContent='failed';}
};
</script></body></html>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/api/models") {
      return Response.json({ default: defaultModelId(env), models: parseModels(env).map((s) => ({ id: s.id, name: s.name ?? s.id })) });
    }

    if (url.pathname === "/api/ask") {
      let prompt = url.searchParams.get("prompt") ?? "";
      let model = url.searchParams.get("model") ?? undefined;
      let session = url.searchParams.get("session") ?? "demo";
      if (request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { prompt?: string; model?: string; session?: string };
        prompt = body.prompt ?? prompt;
        model = body.model ?? model;
        session = body.session ?? session;
      }
      if (!prompt.trim()) {
        return Response.json(
          { error: "empty prompt", usage: "POST /api/ask {prompt, model?} or GET /api/ask?prompt=..." },
          { status: 400 },
        );
      }
      const agent = env.Assistant.getByName(session);
      const { text, status, reason, error } = await agent.ask(prompt, model);
      return Response.json({ session, model: model ?? defaultModelId(env), status, text, reason, error });
    }

    if (url.pathname === "/api/state") {
      const agent = env.Assistant.getByName(url.searchParams.get("session") ?? "demo");
      return Response.json(await agent.agentInfo());
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
};
