/* global __ENV, __VU, __ITER */
// k6 script for the load test, started by load.ts. 40 VUs x 25 webhook calls = 1,000 runs.
// Webhooks are rate limited to 60 calls a minute per client IP, so load.ts passes --local-ips and each VU sends from its own loopback address.
import { check } from "k6";
import http from "k6/http";

export const options = {
  scenarios: { webhooks: { executor: "per-vu-iterations", vus: 40, iterations: 25, maxDuration: "5m" } },
  thresholds: { checks: ["rate==1"] },
};

export default function () {
  const res = http.post(`${__ENV.BASE_URL}/hooks/${__ENV.HOOK}`, JSON.stringify({ n: `${__VU}-${__ITER}` }), { headers: { "content-type": "application/json" } });
  check(res, { "accepted (202)": (r) => r.status === 202 });
}
