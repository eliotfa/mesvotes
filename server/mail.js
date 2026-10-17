// Envoi d'e-mails par SMTP, sans dépendance (STARTTLS sur 587 ou TLS direct sur 465).
// Un message peut avoir une version HTML (voir mail-template.js) en plus du texte brut.
// Sans SMTP_HOST, les e-mails sont simplement écrits dans les journaux du serveur.
// Chaque envoi est journalisé : succès avec la réponse finale du serveur, échec avec l'étape SMTP en cause.
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import os from "node:os";
import { config } from "./config.js";

const b64 = s => Buffer.from(s, "utf8").toString("base64");
const encodeHeader = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
const addr = s => (String(s).match(/<([^>]+)>/) || [null, s])[1].trim();
// Pour les journaux : « ana@exemple.fr » devient « a***@exemple.fr ».
export const maskEmail = s => { const m = String(s).match(/^(.)[^@]*@(.+)$/); return m ? `${m[1]}***@${m[2]}` : "***"; };

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

// Corps du message : texte seul, ou texte + HTML en multipart/alternative (le client affiche le HTML s'il le sait).
const b64Body = s => b64(s).replace(/.{1,76}/g, "$&\r\n");
function mimeBody(text, html) {
  if (!html) return ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64Body(text)];
  const boundary = "=_mesvotes_" + crypto.randomUUID();
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64Body(text),
    `--${boundary}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64Body(html),
    `--${boundary}--`
  ];
}

// Renvoie la dernière réponse du serveur (ex. « 250 2.0.0 OK »). En cas d'erreur, e.step indique l'étape en cause.
async function smtpSend({ to, subject, text, html }) {
  const { host, port, secure, user, pass, from } = config.smtp;
  let step = "connexion", socket;
  try {
    socket = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    socket.setTimeout(20000, () => socket.destroy(new Error("délai dépassé")));
    await new Promise((res, rej) => { socket.once(secure ? "secureConnect" : "connect", res); socket.once("error", rej); });
    let r = reader(socket); r.attach(socket);
    let last = "";
    const expect = async (code) => {
      const lines = await r.next(); last = lines[lines.length - 1];
      if (!last.startsWith(String(code))) throw new Error(`réponse inattendue « ${last} »`);
      return lines;
    };
    const cmd = async (line, code) => { socket.write(line + "\r\n"); return expect(code); };
    step = "accueil du serveur";
    await expect(220);
    step = "EHLO";
    let ehlo = await cmd(`EHLO ${os.hostname() || "mesvotes"}`, 250);
    if (!secure && ehlo.some(l => /STARTTLS/i.test(l))) {
      step = "STARTTLS";
      await cmd("STARTTLS", 220);
      r.detach(socket);
      step = "négociation TLS";
      socket = tls.connect({ socket, servername: host });
      await new Promise((res, rej) => { socket.once("secureConnect", res); socket.once("error", rej); });
      r = reader(socket); r.attach(socket);
      step = "EHLO après TLS";
      ehlo = await cmd(`EHLO ${os.hostname() || "mesvotes"}`, 250);
    }
    if (user) { step = "authentification (AUTH LOGIN)"; await cmd("AUTH LOGIN", 334); await cmd(b64(user), 334); await cmd(b64(pass), 235); }
    step = "MAIL FROM";
    await cmd(`MAIL FROM:<${addr(from)}>`, 250);
    step = "RCPT TO";
    await cmd(`RCPT TO:<${addr(to)}>`, 250);
    step = "DATA";
    await cmd("DATA", 354);
    step = "envoi du message";
    const msg = [
      `From: ${from}`, `To: ${to}`, `Subject: ${encodeHeader(subject)}`, `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@${addr(from).split("@")[1] || "mesvotes.fr"}>`,
      "MIME-Version: 1.0", ...mimeBody(text, html)
    ].join("\r\n");
    await cmd(msg + "\r\n.", 250);
    const reply = last;
    socket.write("QUIT\r\n"); socket.end();
    return reply;
  } catch (e) {
    e.step = step;
    socket?.destroy();
    throw e;
  }
}

export async function sendMail(mail) {
  const dest = maskEmail(mail.to);
  if (!config.mailEnabled) {
    console.log(`[mail] (SMTP non configuré) À : ${mail.to}\n[mail] Sujet : ${mail.subject}\n${mail.text}\n`);
    return;
  }
  const { host, port } = config.smtp;
  try {
    const reply = await smtpSend(mail);
    console.log(`[mail] envoyé à ${dest} via ${host}:${port} (réponse : ${reply})`);
  } catch (e) {
    console.error(`[mail] échec d'envoi à ${dest} via ${host}:${port}, étape « ${e.step} » : ${e.code ? e.code + " — " : ""}${e.message}`);
    throw e;
  }
}
