import { appendFileSync } from "node:fs";
import { createServer, type Server } from "node:net";

/**
 * Just enough SMTP for nodemailer to deliver: every message lands as one JSON string per line in `file`,
 * so a test can read the approval link from it. It advertises no extensions, so nodemailer skips STARTTLS.
 */
export function startSmtpSink(port: number, file: string): Promise<Server> {
  const server = createServer((socket) => {
    let inData = false;
    let buffer = "";
    let message = "";
    socket.write("220 e2e sink\r\n");
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let i = buffer.indexOf("\r\n"); i >= 0; i = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            appendFileSync(file, `${JSON.stringify(message)}\n`);
            message = "";
            socket.write("250 queued\r\n");
          } else {
            message += `${line.startsWith("..") ? line.slice(1) : line}\n`;
          }
          continue;
        }
        const command = line.slice(0, 4).toUpperCase();
        if (command === "DATA") {
          inData = true;
          socket.write("354 end with a dot\r\n");
        } else if (command === "QUIT") {
          socket.end("221 bye\r\n");
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
