import { readFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";

/** Loopback mailbox for the browser test. Each JSON line in the spool holds one RFC 5322 message. */
export async function startFakeImap(spool: string) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    const line = (value: string) => socket.write(value + "\r\n");
    line("* OK Daloy test inbox ready");
    let authenticated = false;
    createInterface({ input: socket, crlfDelay: Infinity }).on("line", (input) => {
      const parsed = /^(\S+) (UID \w+|\w+)(?: (.*))?$/i.exec(input);
      if (!parsed) return;
      const [, tag, verb, args = ""] = parsed;
      const messages = readFileSync(spool, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((raw) => JSON.parse(raw) as string);
      switch (verb!.toUpperCase()) {
        case "CAPABILITY":
          line("* CAPABILITY IMAP4rev1");
          break;
        case "LOGIN":
          authenticated = /^"?inquiries@example\.test"? "?fixture-inbox-password"?$/i.test(args);
          if (!authenticated) return void line(`${tag} NO Invalid fixture credentials`);
          break;
        case "LOGOUT":
          line("* BYE Closing test inbox");
          line(`${tag} OK LOGOUT`);
          socket.end();
          return;
        default:
          if (!authenticated) return void line(`${tag} NO Authenticate first`);
          if (verb === "LIST" || verb === "LSUB") {
            line(`* ${verb} (\\HasNoChildren) "/" "INBOX"`);
          } else if (verb === "EXAMINE" && /^"?INBOX"?$/i.test(args)) {
            line("* FLAGS (\\Seen)");
            line(`* ${messages.length} EXISTS`);
            line("* OK [UIDVALIDITY 104] Stable mailbox");
            line(`* OK [UIDNEXT ${messages.length + 1}] Next UID`);
            return void line(`${tag} OK [READ-ONLY] Mailbox opened`);
          } else if (verb === "UID SEARCH") {
            const range = /\bUID ([\d*:]+)/i.exec(args)?.[1] ?? "1:*";
            line(
              "* SEARCH" +
                selectedUids(range, messages.length)
                  .map((uid) => " " + uid)
                  .join(""),
            );
          } else if (verb === "UID FETCH") {
            const [range = "", ...items] = args.split(" ");
            const query = items.join(" ");
            for (const uid of selectedUids(range, messages.length)) {
              const body = Buffer.from(messages[uid - 1]!);
              let attributes = `UID ${uid}`;
              if (/RFC822\.SIZE/i.test(query)) attributes += ` RFC822.SIZE ${body.length}`;
              if (/INTERNALDATE/i.test(query)) attributes += ' INTERNALDATE "17-Nov-2026 10:00:00 +0000"';
              const fetchBody = /BODY(?:\.PEEK)?\[\](?:<(\d+)\.(\d+)>)?/i.exec(query);
              if (fetchBody) {
                const [, offset, length] = fetchBody;
                const bytes = offset ? body.subarray(Number(offset), Number(offset) + Number(length)) : body;
                line(`* ${uid} FETCH (${attributes} BODY[]${offset ? "<" + offset + ">" : ""} {${bytes.length}}`);
                socket.write(bytes);
                line(")");
              } else {
                line(`* ${uid} FETCH (${attributes})`);
              }
            }
          } else if (verb !== "NOOP") {
            return void line(`${tag} BAD Unsupported test command ${verb}`);
          }
      }
      line(`${tag} OK ${verb} completed`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not get a TCP port");
  return {
    url: `imap://127.0.0.1:${address.port}`,
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function selectedUids(range: string, count: number): number[] {
  const ranges = range.split(",").map((part) => {
    const [first, last = first] = part.replaceAll("*", String(count)).split(":").map(Number);
    return [Math.min(first!, last!), Math.max(first!, last!)] as const;
  });
  return Array.from({ length: count }, (_, i) => i + 1).filter((uid) => ranges.some(([low, high]) => low <= uid && uid <= high));
}
