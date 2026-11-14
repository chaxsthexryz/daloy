import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendEmail, type Mailer } from "./mail";

/**
 * A scripted SMTP server for the failure windows of decision 0030. Each mode fails at one point of the session;
 * received counts the messages that reached the end of DATA.
 */
type Mode = "ok" | "close_on_rcpt" | "refuse_data_451" | "close_after_354" | "close_after_dot" | "hang_after_dot" | "451_after_dot" | "554_after_dot";
let mode: Mode = "ok";
let received = 0;
let server: Server;
let port: number;
const sockets = new Set<Socket>();

beforeAll(async () => {
  server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let inData = false;
    let buffer = "";
    socket.write("220 scripted\r\n");
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let i = buffer.indexOf("\r\n"); i >= 0; i = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line !== ".") continue;
          inData = false;
          received++;
          if (mode === "close_after_dot") return socket.destroy();
          if (mode === "hang_after_dot") return;
          socket.write(mode === "451_after_dot" ? "451 4.3.0 try later\r\n" : mode === "554_after_dot" ? "554 5.7.1 rejected\r\n" : "250 queued\r\n");
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO" || verb === "HELO") socket.write("250 scripted\r\n");
        else if (verb === "MAIL") socket.write("250 ok\r\n");
        else if (verb === "RCPT") {
          if (mode === "close_on_rcpt") return socket.destroy();
          socket.write("250 ok\r\n");
        } else if (verb === "DATA") {
          if (mode === "refuse_data_451") {
            socket.write("451 4.3.0 not now\r\n");
            continue;
          }
          socket.write("354 go ahead\r\n");
          if (mode === "close_after_354") return socket.destroy();
          inData = true;
        } else if (verb === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise((r) => server.close(r));
});

const mailer = (): Mailer => ({
  transport: nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true, socketTimeout: 300 }),
  from: "Daloy <daloy@example.com>",
});
const email = { to: "a@example.com", subject: "Order A-1", text: "Hello" };

async function failure(m: Mode) {
  mode = m;
  const before = received;
  const err = await sendEmail(mailer(), email, "run:notify:1").then(
    () => undefined,
    (e: unknown) => e as { outcome?: string; retryable?: boolean },
  );
  expect(err, m).toBeDefined();
  return { outcome: err!.outcome, retryable: err!.retryable, received: received - before };
}

describe("sendEmail outcome windows (decision 0030)", () => {
  it("sends a message through the scripted server", async () => {
    mode = "ok";
    const before = received;
    await sendEmail(mailer(), email, "run:notify:1");
    expect(received - before).toBe(1);
  });

  it("retries a connection that drops before DATA: nothing of the message was written", async () => {
    expect(await failure("close_on_rcpt")).toEqual({ outcome: "not_sent", retryable: true, received: 0 });
  });

  it("retries a 4xx answer to the DATA command itself: the server never asked for the message", async () => {
    expect(await failure("refuse_data_451")).toEqual({ outcome: "throttled", retryable: true, received: 0 });
  });

  it("treats a drop right after 354 as unknown, even before the server read the body", async () => {
    expect(await failure("close_after_354")).toEqual({ outcome: "unknown", retryable: false, received: 0 });
  });

  it("treats a drop after the full message and before the reply as unknown", async () => {
    expect(await failure("close_after_dot")).toEqual({ outcome: "unknown", retryable: false, received: 1 });
  });

  it("treats a timeout waiting for the reply to the message as unknown", async () => {
    expect(await failure("hang_after_dot")).toEqual({ outcome: "unknown", retryable: false, received: 1 });
  });

  it("keeps a definite answer to the message: 4xx retries, 5xx is rejected", async () => {
    expect(await failure("451_after_dot")).toEqual({ outcome: "throttled", retryable: true, received: 1 });
    expect(await failure("554_after_dot")).toEqual({ outcome: "rejected", retryable: false, received: 1 });
  });
});
