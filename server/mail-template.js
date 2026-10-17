// Mise en forme des e-mails : une version HTML sobre aux couleurs du site, et la même chose en texte brut.
// Le HTML n'utilise que des tableaux et des styles en ligne : c'est ce que Gmail, Outlook et Apple Mail affichent fidèlement.
import { config } from "./config.js";

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const C = { paper: "#F3F5F8", surface: "#FFFFFF", ink: "#14213D", text: "#3A4560", muted: "#58647D", soft: "#8A94A8", line: "#D6DCE6", accent: "#D3263C" };

// pseudo : destinataire ; title : titre du message ; paragraphs : paragraphes en texte brut ;
// button : { label, url } facultatif ; note : mention discrète sous le bouton ; preheader : aperçu dans la boîte de réception.
export function renderMail({ pseudo, title, paragraphs = [], button, note, preheader = title }) {
  const site = config.baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");

  const text = [
    `Bonjour ${pseudo},`, ...paragraphs,
    ...(button ? [`${button.label} :\n${button.url}`] : []),
    ...(note ? [note] : []),
    site
  ].join("\n\n");

  const p = (s, last) => `<p style="margin:0 0 ${last ? 0 : 16}px 0;">${esc(s)}</p>`;
  const body = [`Bonjour ${pseudo},`, ...paragraphs].map((s, i, a) => p(s, i === a.length - 1)).join("\n");
  const cta = !button ? "" : `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0 0;">
                <tr><td align="center" bgcolor="${C.accent}" style="border-radius:8px;">
                  <a href="${esc(button.url)}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;">${esc(button.label)}</a>
                </td></tr>
              </table>
              <p style="margin:20px 0 0 0;font-size:12px;line-height:18px;color:${C.soft};">Le bouton ne fonctionne pas ? Copie ce lien dans ton navigateur :<br>
                <a href="${esc(button.url)}" style="color:${C.muted};word-break:break-all;">${esc(button.url)}</a></p>`;
  const noteHtml = !note ? "" : `
              <p style="margin:24px 0 0 0;padding-top:20px;border-top:1px solid ${C.line};font-size:13px;line-height:20px;color:${C.muted};">${esc(note)}</p>`;

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
<style>@media only screen and (max-width:620px){.container{width:100% !important}.px{padding-left:24px !important;padding-right:24px !important}}</style>
</head>
<body style="margin:0;padding:0;background-color:${C.paper};-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${C.paper};">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" class="container" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:560px;">
          <tr>
            <td style="padding:0 4px 20px 4px;font-family:${FONT};font-size:24px;font-weight:800;letter-spacing:-0.3px;color:${C.ink};">
              <a href="${esc(config.baseUrl)}" style="color:${C.ink};text-decoration:none;">mes<span style="color:${C.accent};">votes</span><span style="color:${C.muted};font-size:16px;font-weight:600;">.fr</span></a>
            </td>
          </tr>
          <tr>
            <td class="px" style="background-color:${C.surface};border:1px solid ${C.line};border-radius:12px;padding:40px;font-family:${FONT};">
              <h1 style="margin:0 0 20px 0;font-size:22px;line-height:30px;font-weight:700;color:${C.ink};">${esc(title)}</h1>
              <div style="font-size:15px;line-height:24px;color:${C.text};">
${body}
              </div>${cta}${noteHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:24px 8px 0 8px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.soft};text-align:center;">
              Tu reçois cet e-mail pour ton compte sur <a href="${esc(config.baseUrl)}" style="color:${C.muted};">${esc(site)}</a>.<br>
              mesvotes, plateforme de démocratie directe.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { text, html };
}
