import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";

export type FakeMessage = { user: string | undefined; from: string; to: string[]; raw: string };

/**
 * A stand-in for smtp.gmail.com in tests: plain TCP, AUTH PLAIN and LOGIN, no TLS. It records which account each
 * message was sent as. A password listed in `reject` gets the 535 answer Gmail gives for a wrong app password.
 */
export async function startFakeSmtp(reject: Set<string> = new Set()) {
  const messages: FakeMessage[] = [];
  const logins: { user: string; ok: boolean }[] = [];
  const server: Server = createServer((socket) => {
    let user: string | undefined;
    let pending: "plain" | "login-user" | "login-pass" | undefined;
    let loginUser = "";
    let mail: { from: string; to: string[] } = { from: "", to: [] };
    let data: string[] | undefined;
    let buffer = "";
    const auth = (u: string, p: string) => {
      const ok = !reject.has(p);
      logins.push({ user: u, ok });
      if (ok) user = u;
      socket.write(ok ? "235 2.7.0 Accepted\r\n" : "535 5.7.8 Username and Password not accepted\r\n");
    };
    const plain = (b64: string) => {
      const [, u = "", p = ""] = Buffer.from(b64, "base64").toString("utf8").split("\0");
      auth(u, p);
    };
    const b64 = (s: string) => Buffer.from(s, "base64").toString("utf8");
    socket.write("220 fake smtp\r\n");
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let i = buffer.indexOf("\r\n"); i >= 0; i = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (data) {
          if (line === ".") {
            messages.push({ user, ...mail, raw: data.join("\n") });
            data = undefined;
            socket.write("250 queued\r\n");
          } else data.push(line.startsWith("..") ? line.slice(1) : line);
          continue;
        }
        if (pending === "plain") {
          pending = undefined;
          plain(line);
          continue;
        }
        if (pending === "login-user") {
          loginUser = b64(line);
          pending = "login-pass";
          socket.write(`334 ${Buffer.from("Password:").toString("base64")}\r\n`);
          continue;
        }
        if (pending === "login-pass") {
          pending = undefined;
          auth(loginUser, b64(line));
          continue;
        }
        const [verb = "", ...rest] = line.split(" ");
        switch (verb.toUpperCase()) {
          case "EHLO":
            socket.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
            break;
          case "AUTH":
            if (rest[0]?.toUpperCase() === "PLAIN") {
              if (rest[1]) plain(rest[1]);
              else {
                pending = "plain";
                socket.write("334 \r\n");
              }
            } else {
              pending = "login-user";
              socket.write(`334 ${Buffer.from("Username:").toString("base64")}\r\n`);
            }
            break;
          case "MAIL":
            mail = { from: /<([^>]*)>/.exec(line)?.[1] ?? "", to: [] };
            socket.write("250 ok\r\n");
            break;
          case "RCPT":
            mail.to.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
            socket.write("250 ok\r\n");
            break;
          case "DATA":
            data = [];
            socket.write("354 end with a dot\r\n");
            break;
          case "QUIT":
            socket.end("221 bye\r\n");
            break;
          default:
            socket.write("250 ok\r\n");
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    messages,
    logins,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
