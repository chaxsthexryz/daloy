import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { docsFromTemplate, docsKeyFor, docsTemplateInfo } from "./google-docs";
import { ProviderError, type ProviderUrls } from "./providers";

// Phase I1, decision 0104. The Drive and Docs APIs are a local stub that keeps files in memory and applies
// replaceAllText the way Docs does, so the tests see the copied text and not only the requests.
const TOKEN = "ya29.synthetic-access-token-for-tests"; // gitleaks:allow (synthetic)
const TEMPLATE = "1TemplateIdAbCdEfGh";
const FOLDER = "1FolderIdAbCdEfGhIj";
const BODY = "Dear {{name}}, you owe {{total}}. Ref {{ref}}. Again {{name}}.";

type File = { id: string; name: string; parents: string[]; appProperties: Record<string, string>; text: string };
type Fail = { status: number; headers?: Record<string, string>; body?: unknown } | "drop";

let stub: Server;
let files: File[];
let calls: { method: string; path: string; auth: string | undefined }[];
let failOn: Record<string, Fail>; // "copy" | "list" | "batch"
let urls: ProviderUrls;
let seq: number;

const read = (req: IncomingMessage) => new Promise<string>((resolve) => {
  let b = "";
  req.on("data", (c: Buffer) => (b += c.toString()));
  req.on("end", () => resolve(b));
});

type Req = { replaceAllText: { containsText: { text: string; matchCase: boolean }; replaceText: string } };

beforeAll(async () => {
  stub = createServer((req, res) => {
    void read(req).then((raw) => {
      const url = new URL(req.url ?? "/", "http://stub");
      const path = url.pathname;
      calls.push({ method: req.method ?? "", path: path + url.search, auth: req.headers.authorization });
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
      const maybeFail = (name: string) => {
        const f = failOn[name];
        if (!f) return false;
        if (f === "drop") return req.socket.destroy(), true;
        send(f.status, f.body ?? {}, f.headers);
        return true;
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { code: 401, message: "Invalid Credentials" } });
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (req.method === "GET" && path === "/drive/v3/files") {
        if (maybeFail("list")) return;
        const q = url.searchParams.get("q") ?? "";
        const key = /value='([^']+)'/.exec(q)?.[1];
        return send(200, { files: files.filter((f) => f.appProperties.daloyKey === key).map((f) => ({ id: f.id, name: f.name })) });
      }
      const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(path)?.[1];
      if (req.method === "GET" && one) {
        if (maybeFail("info")) return;
        if (one === TEMPLATE) return send(200, { id: one, name: "Invoice template", mimeType: "application/vnd.google-apps.document" });
        if (one === "1FolderIdAbCdEfGhIj") return send(200, { id: one, name: "A folder", mimeType: "application/vnd.google-apps.folder" });
        return send(404, { error: { code: 404, message: `File not found: ${one}.` } });
      }
      const copy = /^\/drive\/v3\/files\/([^/]+)\/copy$/.exec(path)?.[1];
      if (req.method === "POST" && copy) {
        if (maybeFail("copy")) return;
        if (copy !== TEMPLATE) return send(404, { error: { code: 404, message: `File not found: ${copy}.`, errors: [{ reason: "notFound" }] } });
        const f: File = { id: `1Copy${String(++seq).padStart(10, "0")}`, name: String(body.name), parents: body.parents as string[], appProperties: body.appProperties as Record<string, string>, text: BODY };
        files.push(f);
        return send(200, { id: f.id, name: f.name });
      }
      const batch = /^\/v1\/documents\/([^/]+):batchUpdate$/.exec(path)?.[1];
      if (req.method === "POST" && batch) {
        if (maybeFail("batch")) return;
        const f = files.find((x) => x.id === batch);
        if (!f) return send(404, { error: { code: 404, message: "Requested entity was not found." } });
        const replies = (body.requests as Req[]).map((r) => {
          const { text, matchCase } = r.replaceAllText.containsText;
          expect(matchCase).toBe(true);
          const n = f.text.split(text).length - 1;
          f.text = f.text.split(text).join(r.replaceAllText.replaceText);
          return { replaceAllText: { occurrencesChanged: n } };
        });
        return send(200, { documentId: f.id, replies });
      }
      send(404, { error: { code: 404, message: `no route ${path}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  urls = { drive: base, docs: base, timeoutMs: 1000 } as ProviderUrls;
});
afterAll(() => void stub.close());
beforeEach(() => {
  files = [];
  calls = [];
  failOn = {};
  seq = 0;
});

const auth = { accessToken: TOKEN };
const run = (o: Partial<Parameters<typeof docsFromTemplate>[2]> = {}) => docsFromTemplate(urls, auth, { templateId: TEMPLATE, folderId: FOLDER, name: "Invoice REQ-7", values: { name: "Ana Cruz", total: "PHP 1,200" }, key: docsKeyFor("run-1:step-1"), ...o });
const failure = async (o: Parameters<typeof run>[0] = {}) => {
  const err = await run(o).then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  return err as ProviderError;
};

describe("docsFromTemplate", () => {
  it("copies the template into the folder under the new name, fills the placeholders and returns the link", async () => {
    const out = await run();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: "Invoice REQ-7", parents: [FOLDER], text: "Dear Ana Cruz, you owe PHP 1,200. Ref {{ref}}. Again Ana Cruz." });
    expect(out).toEqual({ documentId: files[0]!.id, url: `https://docs.google.com/document/d/${files[0]!.id}/edit`, name: "Invoice REQ-7", reused: false, unmatched: [] });
  });

  it("tells which placeholders matched nothing in the template", async () => {
    const out = await run({ values: { name: "Ana", missing: "x" } });
    expect(out.unmatched).toEqual(["missing"]);
  });

  it("sends the access token as a bearer header on every call and puts no key or token in a URL", async () => {
    await run();
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) {
      expect(c.auth).toBe(`Bearer ${TOKEN}`);
      expect(c.path).not.toContain(TOKEN);
    }
  });

  it("does not copy twice when the step is retried with the same key", async () => {
    const first = await run();
    const second = await run();
    expect(files).toHaveLength(1);
    expect(second).toMatchObject({ documentId: first.documentId, reused: true });
    // The copy is already filled, so the retry finds nothing left to replace and says so honestly.
    expect(files[0]!.text).toBe("Dear Ana Cruz, you owe PHP 1,200. Ref {{ref}}. Again Ana Cruz.");
  });

  it("finishes the fill on a retry when the first attempt copied the file but could not fill it", async () => {
    failOn = { batch: { status: 503 } };
    expect((await failure()).kind).toBe("unavailable");
    expect(files).toHaveLength(1);
    expect(files[0]!.text).toBe(BODY);
    failOn = {};
    const out = await run();
    expect(files).toHaveLength(1);
    expect(out.reused).toBe(true);
    expect(files[0]!.text).toBe("Dear Ana Cruz, you owe PHP 1,200. Ref {{ref}}. Again Ana Cruz.");
  });

  it("makes a separate copy for a different run or step", async () => {
    await run();
    await run({ key: docsKeyFor("run-2:step-1") });
    expect(files).toHaveLength(2);
  });

  it("treats a value that looks like a placeholder as plain text", async () => {
    await run({ values: { name: "{{total}}", total: "PHP 5" } });
    expect(files[0]!.text).toBe("Dear {{total}}, you owe PHP 5. Ref {{ref}}. Again {{total}}.");
  });

  it("makes the copy without a replace call when there are no values", async () => {
    await run({ values: {} });
    expect(calls.some((c) => c.path.includes("batchUpdate"))).toBe(false);
    expect(files[0]!.text).toBe(BODY);
  });

  it("refuses an empty name and a name Drive would keep too long, before any request", async () => {
    expect((await failure({ name: "  " })).kind).toBe("invalid");
    expect((await failure({ name: "x".repeat(201) })).kind).toBe("invalid");
    expect(calls).toHaveLength(0);
  });

  it("refuses a template or folder id that is not a file id, before any request", async () => {
    expect((await failure({ templateId: "../x" })).kind).toBe("invalid");
    expect((await failure({ folderId: "a b" })).kind).toBe("invalid");
    expect(calls).toHaveLength(0);
  });

  it("needs a Google sign-in, since a service account has no storage of its own", async () => {
    const err = await docsFromTemplate(urls, { client_email: "sa@x.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----" }, { templateId: TEMPLATE, folderId: FOLDER, name: "x", values: {}, key: "k" }).then(() => undefined, (e: unknown) => e);
    expect(err).toMatchObject({ kind: "invalid" });
    expect(calls).toHaveLength(0);
  });
});

describe("docsFromTemplate error mapping", () => {
  it("asks for the template to be picked again when Google cannot find or open it", async () => {
    const err = await failure({ templateId: "1OtherTemplateIdXyz" });
    expect(err.kind).toBe("permission");
    expect(err.message).toMatch(/pick the template again/i);
  });
  it("maps 403 on the copy to permission", async () => {
    failOn = { copy: { status: 403, body: { error: { code: 403, message: "The user does not have sufficient permissions", errors: [{ reason: "insufficientFilePermissions" }] } } } };
    expect((await failure()).kind).toBe("permission");
  });
  it("tells a full Drive from a missing permission", async () => {
    failOn = { copy: { status: 403, body: { error: { code: 403, message: "quota", errors: [{ reason: "storageQuotaExceeded" }] } } } };
    const err = await failure();
    expect(err.kind).toBe("permission");
    expect(err.message).toMatch(/storage is full/i);
  });
  it("maps 401 to auth", async () => {
    failOn = { copy: { status: 401, body: { error: { code: 401 } } } };
    expect((await failure()).kind).toBe("auth");
  });
  it("maps 429 and rateLimitExceeded to quota with the wait Google asked for", async () => {
    failOn = { copy: { status: 429, headers: { "retry-after": "12" } } };
    expect(await failure()).toMatchObject({ kind: "quota", retryAfterMs: 12_000 });
    failOn = { copy: { status: 403, body: { error: { errors: [{ reason: "userRateLimitExceeded" }] } } } };
    expect((await failure()).kind).toBe("quota");
  });
  it("retries a 5xx, a timeout or a dropped connection on the copy, because the next attempt looks for its own copy first", async () => {
    failOn = { copy: { status: 500 } };
    expect((await failure()).kind).toBe("unavailable");
    failOn = { copy: "drop" };
    expect((await failure()).kind).toBe("unavailable");
  });
  it("says when the Google Docs API is not turned on for the Google project", async () => {
    failOn = { batch: { status: 403, body: { error: { code: 403, message: "Google Docs API has not been used in project 123 before or it is disabled.", status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } } } };
    const err = await failure();
    expect(err.kind).toBe("permission");
    expect(err.message).toMatch(/Google Docs API/);
  });
  it("maps a lost list call to unavailable, so a retry does not guess", async () => {
    failOn = { list: { status: 503 } };
    expect((await failure()).kind).toBe("unavailable");
    expect(files).toHaveLength(0);
  });
  it("never puts the token or a URL in an error", async () => {
    for (const f of [{ status: 401 }, { status: 403 }, { status: 404 }, { status: 429 }, { status: 500 }] as const) {
      failOn = { copy: { ...f, body: { error: { message: `bad request ${TOKEN} http://127.0.0.1/x` } } } };
      const m = (await failure()).message;
      expect(m).not.toContain(TOKEN);
      expect(m).not.toContain("127.0.0.1");
    }
  });
});

describe("docsKeyFor", () => {
  it("is stable, hides the input and fits Drive's property rules", () => {
    expect(docsKeyFor("run-1:step-1")).toBe(docsKeyFor("run-1:step-1"));
    expect(docsKeyFor("run-1:step-1")).not.toBe(docsKeyFor("run-1:step-2"));
    expect(docsKeyFor("run-1:step-1")).toMatch(/^[a-f0-9]{40}$/);
  });
});

describe("docsTemplateInfo", () => {
  it("returns the name of a Google Docs file the grant can open", async () => {
    expect(await docsTemplateInfo(urls, auth, TEMPLATE)).toEqual({ templateId: TEMPLATE, title: "Invoice template" });
  });
  it("refuses a folder, a file the grant cannot see, a bad id and a service account", async () => {
    await expect(docsTemplateInfo(urls, auth, FOLDER)).rejects.toMatchObject({ kind: "invalid", message: expect.stringMatching(/not a Google Docs/) });
    await expect(docsTemplateInfo(urls, auth, "1NotPickedByThisAccount")).rejects.toMatchObject({ kind: "permission", message: expect.stringMatching(/pick the template again/i) });
    await expect(docsTemplateInfo(urls, auth, "../x")).rejects.toMatchObject({ kind: "invalid" });
    await expect(docsTemplateInfo(urls, { client_email: "a@b.c", private_key: "PRIVATE KEY" }, TEMPLATE)).rejects.toMatchObject({ kind: "invalid" });
  });
});
