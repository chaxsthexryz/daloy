import { connectionCredential, createCheckoutSession, findPaymentForStep, insertPayment, pesosToCentavos, ProviderError, type Db, type Payment } from "@daloy/db";
import { StepError, type Outcome } from "@daloy/engine";

type Link = { amount: string; description: string; reference: string };
type Where = { userId: string; workflowId: string; runId: string; stepId: string; idempotencyKey: string };

const output = (p: Payment) => ({ paymentId: p.id, url: p.url, reference: p.reference, amount: p.amountCentavos, status: p.status });

// Same reading of a provider's answer as an HTTP step: a quota or an unreachable PayMongo is retried, a refusal is not,
// and a timeout after the request left may have created the session, so a person decides (decision 0030).
function stepError(err: ProviderError): StepError {
  const retryable = err.kind === "quota" || err.kind === "unavailable";
  const outcome: Outcome = err.kind === "quota" ? "throttled" : err.kind === "unavailable" ? "not_sent" : err.kind === "ambiguous" || err.kind === "review" ? "unknown" : "rejected";
  return new StepError(err.message, retryable, { cause: err, outcome, retryAfterMs: err.retryAfterMs });
}

/** One checkout link per run and step: a re-run returns the stored payment and calls PayMongo no more. */
export async function paymongoLink(db: Db, key: Buffer, at: Where, cfg: Link, claim: () => Promise<void>) {
  let amountCentavos: number;
  try {
    amountCentavos = pesosToCentavos(cfg.amount);
  } catch (err) {
    throw new StepError((err as Error).message, false);
  }
  const existing = await findPaymentForStep(db, at.runId, at.stepId);
  if (existing) return output(existing);
  const conn = await connectionCredential(db, key, at.userId, "paymongo");
  if (!conn) throw new StepError("Connect PayMongo first.", false);
  const { secretKey } = JSON.parse(conn.credential) as { secretKey: string };
  await claim();
  try {
    const session = await createCheckoutSession({ secretKey, amountCentavos, description: cfg.description, reference: cfg.reference, idempotencyKey: at.idempotencyKey, metadata: { daloy_run: at.runId, daloy_step: at.stepId, reference: cfg.reference } });
    return output(await insertPayment(db, { userId: at.userId, workflowId: at.workflowId, runId: at.runId, stepId: at.stepId, reference: cfg.reference, amountCentavos, livemode: session.livemode, providerSessionId: session.id, url: session.url }));
  } catch (err) {
    throw err instanceof ProviderError ? stepError(err) : err;
  }
}
