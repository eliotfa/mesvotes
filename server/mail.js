// Envoi d'e-mails par SMTP, sans dépendance (STARTTLS sur 587 ou TLS direct sur 465).
// Sans SMTP_HOST, les e-mails sont simplement écrits dans les journaux du serveur.
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import os from "node:os";
import { config } from "./config.js";

const b64 = s => Buffer.from(s, "utf8").toString("base64");
const encodeHeader = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
const addr = s => (String(s).match(/<([^>]+)>/) || [null, s])[1].trim();

function reader(socket) {
  let buf = "", waiting = null, lines = [];
  const onData = d => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\r\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2); lines.push(line);
      if (/^\d{3} /.test(line) && waiting) { const w = waiting; waiting = null; const all = lines; lines = []; w(all); }
    }
  };
  return {
    attach(s) { s.on("data", onData); },
    detach(s) { s.off("data", onData); },
    next() { return new Promise(r => { waiting = r; if (lines.length && /^\d{3} /.test(lines[lines.length - 1])) { waiting = null; const all = lines; lines = []; r(all); } }); }
  };
}

async function smtpSend({ to, subject, text }) {
  const { host, port, secure, user, pass, from } = config.smtp;
  let socket = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
  socket.setTimeout(20000, () => socket.destroy(new Error("Délai SMTP dépassé")));
  await new Promise((res, rej) => { socket.once(secure ? "secureConnect" : "connect", res); socket.once("error", rej); });
  let r = reader(socket); r.attach(socket);
  const expect = async (code) => {
    const lines = await r.next(), last = lines[lines.length - 1];
    if (!last.startsWith(String(code))) throw new Error(`SMTP : réponse inattendue « ${last} »`);
    return lines;
  };
  const cmd = async (line, code) => { socket.write(line + "\r\n"); return expect(code); };
  await expect(220);
  let ehlo = await cmd(`EHLO ${os.hostname() || "mesvotes"}`, 250);
  if (!secure && ehlo.some(l => /STARTTLS/i.test(l))) {
    await cmd("STARTTLS", 220);
    r.detach(socket);
    socket = tls.connect({ socket, servername: host });
    await new Promise((res, rej) => { socket.once("secureConnect", res); socket.once("error", rej); });
    r = reader(socket); r.attach(socket);
    ehlo = await cmd(`EHLO ${os.hostname() || "mesvotes"}`, 250);
  }
  if (user) { await cmd("AUTH LOGIN", 334); await cmd(b64(user), 334); await cmd(b64(pass), 235); }
  await cmd(`MAIL FROM:<${addr(from)}>`, 250);
  await cmd(`RCPT TO:<${addr(to)}>`, 250);
  await cmd("DATA", 354);
  const msg = [
    `From: ${from}`, `To: ${to}`, `Subject: ${encodeHeader(subject)}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${addr(from).split("@")[1] || "mesvotes.fr"}>`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "",
    b64(text).replace(/.{1,76}/g, "$&\r\n")
  ].join("\r\n");
  await cmd(msg + "\r\n.", 250);
  socket.write("QUIT\r\n"); socket.end();
}

export async function sendMail(mail) {
  if (!config.mailEnabled) {
    console.log(`[mail] (SMTP non configuré) À : ${mail.to}\n[mail] Sujet : ${mail.subject}\n${mail.text}\n`);
    return;
  }
  try { await smtpSend(mail); }
  catch (e) { console.error("[mail] échec d'envoi :", e.message); throw e; }
}
