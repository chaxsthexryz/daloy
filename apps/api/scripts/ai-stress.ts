// AI stress test: plays each case in ai-stress-cases.json as a seller chatting in Build with AI, through the same
// chatTurn() the API runs, against the model in .env. It spends real tokens. Run it from the repo root:
//   pnpm ai:stress            (all cases)   pnpm ai:stress tl-booking typo-1   (some cases)
// It prints a summary and writes every conversation to ai-stress-results.json for reading.
import { readFileSync, writeFileSync } from "node:fs";
import { localConnection } from "@daloy/db";
import { HttpException } from "@nestjs/common";
import { chatTurn } from "../src/ai-chat";

type Case = {
  id: string;
  lang: string;
  say: string;
  answers?: string[];
  change?: string;
  apps?: string[];
  review?: boolean;
  note?: string;
  expect: { trigger?: string; steps?: string[]; absent?: string[] };
};
type Msg = { role: "user" | "assistant"; content: string };
type Draft = Extract<Awaited<ReturnType<typeof chatTurn>>, { kind: "draft" }>;

const BUILD_NOW = "Build it now with what you have."; // what the console's "Build it now" button sends
const MAX_TURNS = 8;
const CONCURRENCY = Number(process.env.AI_STRESS_CONCURRENCY || 6);

const { model, ...base } = localConnection();
const connection = { ...base, apiKey: process.env.LLM_API_KEY || undefined };
const all = JSON.parse(readFileSync(new URL("./ai-stress-cases.json", import.meta.url), "utf8")) as Case[];
const only = process.argv.slice(2);
const cases = only.length ? all.filter((c) => only.includes(c.id)) : all;

/** Chats until a draft or a failure, answering questions from the case and then pressing "Build it now". */
async function converse(c: Case, messages: Msg[], current: unknown, answers: string[], stats: { calls: number; inputTokens: number; outputTokens: number; replies: string[] }) {
  const questions: string[] = [];
  const waits: number[] = [];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const started = performance.now();
    try {
      const reply = await chatTurn({ messages: messages.slice(-20), current, apps: c.apps, model, connection, stats });
      waits.push(performance.now() - started);
      if (reply.kind === "draft") {
        messages.push({ role: "assistant", content: reply.summary });
        return { draft: reply, questions, waits };
      }
      questions.push(reply.text);
      messages.push({ role: "assistant", content: reply.text }, { role: "user", content: answers.shift() ?? BUILD_NOW });
    } catch (err) {
      waits.push(performance.now() - started);
      const error = err instanceof HttpException ? `${err.getStatus()} ${JSON.stringify(err.getResponse())}` : String(err);
      return { error, questions, waits };
    }
  }
  return { error: `no draft after ${MAX_TURNS} turns`, questions, waits };
}

const stepTypes = (d: Draft) => d.definition.steps.map((s) => s.type as string);

/** What a seller would call wrong: the wrong trigger, a missing step, a step they asked to remove, or warnings left. */
function grade(c: Case, d: Draft): string[] {
  const problems: string[] = [];
  const types = stepTypes(d);
  if (c.expect.trigger && !c.expect.trigger.split("|").includes(d.definition.trigger.type)) problems.push(`trigger ${d.definition.trigger.type}, wanted ${c.expect.trigger}`);
  for (const want of c.expect.steps ?? []) if (!want.split("|").some((w) => types.includes(w))) problems.push(`no ${want} step`);
  for (const gone of c.expect.absent ?? []) if (types.includes(gone)) problems.push(`still has ${gone}`);
  if (d.warnings.length) problems.push(`warnings: ${d.warnings.join("; ")}`);
  return problems;
}

async function run(c: Case) {
  const stats = { calls: 0, inputTokens: 0, outputTokens: 0, replies: [] as string[] };
  const messages: Msg[] = [{ role: "user", content: c.say }];
  const first = await converse(c, messages, undefined, [...(c.answers ?? [])], stats);
  let last = first;
  if (c.change && first.draft) {
    messages.push({ role: "user", content: c.change });
    last = await converse(c, messages, first.draft.definition, [], stats);
  }
  const questions = [...first.questions, ...(last === first ? [] : last.questions)];
  const waits = [...first.waits, ...(last === first ? [] : last.waits)];
  const repeated = questions.length - new Set(questions.map((q) => q.toLowerCase())).size;
  const problems = last.draft ? grade(c, last.draft) : [last.error ?? "no draft"];
  const result = {
    id: c.id,
    lang: c.lang,
    ok: Boolean(last.draft) && (c.review || problems.length === 0),
    drafted: Boolean(last.draft),
    review: c.review ?? false,
    problems,
    questions,
    repeated,
    seconds: waits.reduce((a, b) => a + b, 0) / 1000,
    worstWait: Math.max(...waits) / 1000,
    ...stats,
    trigger: last.draft?.definition.trigger.type,
    steps: last.draft ? stepTypes(last.draft) : [],
    name: last.draft?.name,
    summary: last.draft?.summary,
    messages,
    definition: last.draft?.definition,
  };
  const mark = result.ok ? "pass" : result.drafted ? "WEAK" : "FAIL";
  console.log(`${mark} ${c.id.padEnd(20)} ${result.seconds.toFixed(1).padStart(5)}s q=${questions.length} calls=${stats.calls} ${result.trigger ?? ""} [${result.steps.join(",")}] ${problems.join(" | ")}`);
  return result;
}

const results: Awaited<ReturnType<typeof run>>[] = [];
const queue = [...cases];
console.log(`${cases.length} cases on ${model} at ${connection.baseUrl}, ${CONCURRENCY} at a time`);
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
  for (let c = queue.shift(); c; c = queue.shift()) results.push(await run(c));
}));

const pct = (n: number) => `${Math.round((100 * n) / results.length)}%`;
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const at = (xs: number[], p: number) => sorted(xs)[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? 0;
const waits = results.map((r) => r.worstWait);
const totals = results.reduce((a, r) => ({ i: a.i + r.inputTokens, o: a.o + r.outputTokens, calls: a.calls + r.calls }), { i: 0, o: 0, calls: 0 });
const byLang = Object.entries(Object.groupBy(results, (r) => r.lang)).map(([lang, rs]) => `${lang} ${rs!.filter((r) => r.ok).length}/${rs!.length}`);
console.log(`
passed            ${results.filter((r) => r.ok).length}/${results.length} (${pct(results.filter((r) => r.ok).length)})
got a draft       ${pct(results.filter((r) => r.drafted).length)}
by kind           ${byLang.join(", ")}
asked questions   ${pct(results.filter((r) => r.questions.length).length)} of cases, repeated a question in ${results.filter((r) => r.repeated).length}
longest wait      p50 ${at(waits, 0.5).toFixed(1)}s, p95 ${at(waits, 0.95).toFixed(1)}s, max ${Math.max(...waits).toFixed(1)}s
model calls       ${totals.calls}, ${totals.i} input and ${totals.o} output tokens`);
writeFileSync("ai-stress-results.json", JSON.stringify(results.sort((a, b) => a.id.localeCompare(b.id)), null, 2));
