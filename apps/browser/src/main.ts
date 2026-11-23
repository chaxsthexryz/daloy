import { createService } from "./service";

// The browser service's entry point (decision 0108). Reachable only on the compose network "browser"; it publishes no port.
const token = process.env.BROWSER_TOKEN ?? "";
if (token.length < 32) {
  console.error("BROWSER_TOKEN must be set to at least 32 characters (openssl rand -hex 32).");
  process.exit(1);
}
const positive = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
const service = await createService({
  token,
  concurrency: positive(process.env.BROWSER_CONCURRENCY, 2),
  jobMs: positive(process.env.BROWSER_JOB_SECONDS, 60) * 1000,
});
const port = positive(process.env.PORT, 3200);
service.server.listen(port, "0.0.0.0", () => console.log(`browser service on port ${port}`));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void service.close().then(() => process.exit(0)));
