// Données d'exemple (SEED_DEMO=true) : comptes fictifs, propositions à toutes les étapes, quelques lois.
// Les comptes fictifs n'ont pas de mot de passe : personne ne peut s'y connecter.
import { q, tx, S } from "./db.js";
import { now, uid, cstNow, journal } from "./model.js";
import { DAY } from "../public/shared/util.js";

const PEOPLE = [["citoyenne_ana", 0], ["Karim.B", 0], ["Sandrine_R", 0], ["juju_lgr", 0], ["Pierre_77", 0], ["Lea.T", 1], ["theo_m", 1], ["Mehdi.asso", 0], ["Nadia.com", 0], ["anonyme_42", 0]];

export function seedIfEmpty() {
  if (q("SELECT 1 x FROM proposals LIMIT 1").get() || q("SELECT 1 x FROM laws LIMIT 1").get()) return false;
  tx(seed);
  console.log("[seed] données d'exemple chargées");
  return true;
}

function seed() {
  const T = now(), ago = d => T - d * DAY, cst = cstNow();
  const users = {};
  const addUser = (pseudo, minor) => {
    const r = q("INSERT INTO users(email,pseudo,pseudo_lc,pass_hash,minor,role,email_verified,created_at) VALUES (?,?,?,NULL,?,'user',1,?)")
      .run(`${pseudo.toLowerCase()}@exemple.invalid`, pseudo, pseudo.toLowerCase(), minor, ago(400));
    return Number(r.lastInsertRowid);
  };
  PEOPLE.forEach(([p, m]) => users[p] = addUser(p, m));
  // Foule fictive pour les parrainages et les votes d'exemple.
  const crowd = Array.from({ length: 70 }, (_, i) => ({ id: addUser(`citoyen_${String(i + 1).padStart(2, "0")}`, i % 9 === 0 ? 1 : 0), minor: i % 9 === 0 }));

  const law = (title, themes, tags, versions) => {
    const id = "l" + uid(8);
    q("INSERT INTO laws(id,title,themes,tags,status,created_at) VALUES (?,?,?,?,'vigueur',?)").run(id, title, S(themes), S(tags), versions[0][0]);
    versions.forEach(([date, text, note, via], i) => q("INSERT INTO law_versions(law_id,n,date,text,note,via,abrog) VALUES (?,?,?,?,?,?,0)").run(id, i + 1, date, text, note, via || null));
    return id;
  };

  const prop = o => {
    const id = o.id || uid(10);
    q(`INSERT INTO proposals(id,kind,title,summary,author_id,themes,tags,is2027,phase,dates,projet_days,delib_days,rules,const_v,target_law,target_base,const_base,fork_of,law_id,files,links,result,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,'[]',?,?,?)`)
      .run(id, o.kind || "loi", o.title, o.summary, users[o.author], S(o.themes), S(o.tags), o.is2027 ? 1 : 0, o.phase, S(o.dates), o.projetDays || 30, o.delibDays || 90,
        S(cst.params), cst.n, o.target?.lawId ?? null, o.target?.base ?? null, o.constBase ? S(o.constBase) : null, o.lawId || null, S(o.links || []), o.result ? S(o.result) : null, o.dates.projet);
    o.versions.forEach(([d, note, text, c], i) => q("INSERT INTO proposal_versions(proposal_id,n,date,note,text,cst) VALUES (?,?,?,?,?,?)").run(id, i + 1, d, note, text, c ? S(c) : null));
    (o.notes || []).forEach(n => q("INSERT INTO notes(id,proposal_id,type,author_id,date,text,para,base,proposed,status,reports) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(uid(12), id, n.type, users[n.author], ago(n.days), n.text, n.para ?? null, n.base ?? null, n.proposed ?? null, n.status ?? null, n.reports || 0));
    (o.parrains ? crowd.slice(0, o.parrains) : []).forEach(c => q("INSERT INTO parrainages(proposal_id,user_id,date) VALUES (?,?,?)").run(id, c.id, ago(1)));
    (o.votes || []).forEach((choice, i) => q("INSERT INTO votes(proposal_id,user_id,choice,minor,date) VALUES (?,?,?,?,?)").run(id, crowd[i].id, choice, crowd[i].minor ? 1 : 0, ago(1)));
    return id;
  };

  const guichetText = "Toutes les démarches d'une entreprise de moins de 10 salariés passent par un seul site et un seul conseiller référent.\n\nUne administration ne peut pas redemander un document déjà fourni à une autre.\n\nSans réponse sous deux mois, une demande est considérée comme acceptée.";
  const guichetId = uid(10);
  const lGuichet = law("Un guichet unique pour créer et gérer son entreprise", ["Économie"], ["entreprises", "simplification"], [[ago(19), guichetText, "Adoptée par vote · 76,4 % pour", guichetId]]);
  law("Budget participatif national", ["Institutions", "Économie"], ["budget", "participation"], [
    [ago(420), "Chaque année, 2 % du budget d'investissement de l'État sont affectés à des projets proposés et choisis par les citoyens.\n\nLes projets sont déposés en ligne, examinés pour leur faisabilité, puis soumis au vote pendant un mois.\n\nUn bilan de réalisation des projets est publié chaque année.", "Adoptée par vote · 71,2 % pour"],
    [ago(140), "Chaque année, 5 % du budget d'investissement de l'État sont affectés à des projets proposés et choisis par les citoyens.\n\nLes projets sont déposés en ligne, examinés pour leur faisabilité, puis soumis au vote pendant un mois.\n\nUn bilan est publié chaque année, avec l'avancement et le coût de chaque projet.", "Modification adoptée : « Porter le budget participatif à 5 % » · 63,8 % pour"]
  ]);
  const lPub = law("Fin des écrans publicitaires numériques dans l'espace public", ["Écologie"], ["publicité", "énergie"], [
    [ago(510), "Les écrans publicitaires numériques sont interdits sur la voie publique et dans les vitrines visibles depuis la rue.\n\nLes écrans d'information des services publics et des transports ne sont pas concernés.\n\nLes écrans existants sont retirés dans un délai de deux ans.", "Adoptée par vote · 58,1 % pour"]]);

  const ricV1 = "Un référendum peut être déclenché par 1 million de citoyens.\n\nIl peut porter sur toute loi, sauf la Constitution.\n\nLe vote a lieu dans l'année qui suit la validation des signatures.";
  const ricV2 = "Un référendum peut être déclenché par 700 000 citoyens inscrits sur les listes électorales, soit environ 1,5 % du corps électoral.\n\nIl peut porter sur toute loi, sauf la Constitution.\n\nLe vote a lieu dans l'année qui suit la validation des signatures.";
  const ricV3 = "Un référendum peut être déclenché par 700 000 citoyens inscrits sur les listes électorales, soit environ 1,5 % du corps électoral.\n\nIl peut proposer, modifier ou abroger une loi. Il ne peut pas porter atteinte aux droits fondamentaux garantis par la Constitution.\n\nLe vote a lieu dans l'année qui suit la validation des signatures.\n\nLe Conseil constitutionnel vérifie la recevabilité de la question avant la collecte des signatures.";
  prop({ title: "Inscrire le référendum d'initiative citoyenne dans la Constitution", summary: "Permettre à 700 000 citoyens de déclencher un référendum pour proposer, modifier ou abroger une loi.",
    author: "citoyenne_ana", themes: ["Institutions"], tags: ["référendum", "démocratie-directe"], is2027: true, phase: "vote",
    dates: { projet: ago(250), parrainage: ago(190), deliberation: ago(180), vote: ago(3) }, projetDays: 60, delibDays: 177, parrains: 55,
    votes: [..."ppppppppppppppppppppccccccccccaaa"],
    links: [{ label: "ch.ch", url: "https://www.ch.ch/fr/votations-et-elections/" }],
    versions: [[ago(250), "Version initiale", ricV1], [ago(225), "Intègre l'amendement de @Karim.B (§1)", ricV2], [ago(200), "Intègre l'amendement de @juju_lgr (§2) et ajoute un §4", ricV3]],
    notes: [
      { type: "amend", author: "Karim.B", days: 240, text: "1 million, c'est hors d'atteinte sans l'appui d'un parti. 700 000 garde un vrai filtre.", para: 1, base: paras(ricV1)[0], proposed: paras(ricV2)[0], status: "accepted" },
      { type: "amend", author: "juju_lgr", days: 210, text: "Il faut un garde-fou, sinon une majorité peut voter contre les droits d'une minorité.", para: 2, base: paras(ricV1)[1], proposed: paras(ricV3)[1], status: "accepted" },
      { type: "source", author: "theo_m", days: 150, text: "Pour comparer : en Suisse, 100 000 signatures suffisent pour une initiative populaire, pour environ 5,6 millions d'électeurs." },
      { type: "comment", author: "Sandrine_R", days: 40, text: "Je suis pour sur le principe, mais j'ai peur que ce soit utilisé par ceux qui ont le plus d'argent pour faire campagne. Qui finance la campagne d'un référendum ?" }
    ] });
  prop({ title: "Reconnaître le vote blanc comme un suffrage exprimé", summary: "Compter les bulletins blancs dans les résultats, et annuler l'élection s'ils arrivent en tête.",
    author: "Karim.B", themes: ["Institutions"], tags: ["vote-blanc", "élections"], is2027: true, phase: "deliberation",
    dates: { projet: ago(110), parrainage: ago(75), deliberation: ago(41) }, projetDays: 35, delibDays: 120, parrains: 52,
    versions: [[ago(110), "Version initiale", "Les bulletins blancs sont comptés comme suffrages exprimés dans toutes les élections.\n\nSi le vote blanc arrive en tête, l'élection est annulée et organisée à nouveau sous trois mois, sans les mêmes candidats."],
      [ago(85), "Intègre l'amendement de @citoyenne_ana (§3)", "Les bulletins blancs sont comptés comme suffrages exprimés dans toutes les élections.\n\nSi le vote blanc arrive en tête, l'élection est annulée et organisée à nouveau sous trois mois, sans les mêmes candidats.\n\nPour l'élection présidentielle, le président sortant reste en fonction jusqu'à la nouvelle élection."]],
    notes: [
      { type: "amend", author: "citoyenne_ana", days: 95, text: "Il faut prévoir ce qui se passe entre les deux élections, sinon il y a un vide.", para: 3, base: "", proposed: "Pour l'élection présidentielle, le président sortant reste en fonction jusqu'à la nouvelle élection.", status: "accepted" },
      { type: "comment", author: "Pierre_77", days: 12, text: "Je reste sceptique : on risque d'enchaîner les élections annulées. Mais l'article sur le président sortant règle une partie du problème." }
    ] });
  prop({ title: "50 % de produits locaux dans les cantines scolaires", summary: "Imposer qu'au moins la moitié des produits servis viennent de moins de 150 km.",
    author: "Sandrine_R", themes: ["Éducation", "Écologie"], tags: ["alimentation", "agriculture", "enfance"], phase: "parrainage",
    dates: { projet: ago(50), parrainage: ago(9) }, projetDays: 40, parrains: 31,
    versions: [[ago(50), "Version initiale", "Les cantines des écoles, collèges et lycées publics servent au moins 50 % de produits issus d'exploitations situées à moins de 150 km.\n\nL'État compense le surcoût pour les communes de moins de 5 000 habitants.\n\nL'objectif est atteint en trois ans, avec un bilan public chaque année."]],
    notes: [
      { type: "comment", author: "Lea.T", days: 30, text: "Dans mon collège la cantine c'est vraiment pas bon, si ça change ça je signe direct." },
      { type: "comment", author: "anonyme_42", days: 20, text: "Encore une idée de bobos qui n'ont jamais travaillé de leur vie.", reports: 2 }
    ] });
  prop({ title: "Publier en open data les dépenses des élus", summary: "Chaque frais de mandat est publié en ligne, avec justificatif, sous 30 jours.",
    author: "juju_lgr", themes: ["Institutions", "Justice"], tags: ["transparence", "élus", "open-data"], is2027: true, phase: "projet",
    dates: { projet: ago(15) }, projetDays: 45, delibDays: 120, links: [{ label: "hatvp.fr", url: "https://www.hatvp.fr/" }],
    versions: [[ago(15), "Version initiale", "Les députés, sénateurs et maires des villes de plus de 10 000 habitants publient leurs frais de mandat.\n\nChaque dépense de plus de 100 € est publiée avec son justificatif.\n\nLes données sont mises en ligne dans un format ouvert."],
      [ago(6), "Intègre l'amendement de @theo_m (§3)", "Les députés, sénateurs et maires des villes de plus de 10 000 habitants publient leurs frais de mandat.\n\nChaque dépense de plus de 100 € est publiée avec son justificatif.\n\nLes données sont mises en ligne sous 30 jours, dans un format ouvert et réutilisable (CSV), sur un site public unique."]],
    notes: [
      { type: "amend", author: "theo_m", days: 10, text: "Sans délai ni format précis, ils vont publier des PDF scannés un an après.", para: 3, base: "Les données sont mises en ligne dans un format ouvert.", proposed: "Les données sont mises en ligne sous 30 jours, dans un format ouvert et réutilisable (CSV), sur un site public unique.", status: "accepted" },
      { type: "amend", author: "Sandrine_R", days: 4, text: "100 €, c'est trop haut : beaucoup de repas passent en dessous.", para: 2, base: "Chaque dépense de plus de 100 € est publiée avec son justificatif.", proposed: "Chaque dépense de plus de 50 € est publiée avec son justificatif.", status: "pending" },
      { type: "comment", author: "Pierre_77", days: 1, text: "Et les conseillers régionaux ? Ils gèrent des budgets énormes." }
    ] });
  prop({ id: guichetId, title: "Un guichet unique pour créer et gérer son entreprise", summary: "Un seul interlocuteur et un seul site pour toutes les démarches des TPE et indépendants.",
    author: "Pierre_77", themes: ["Économie"], tags: ["entreprises", "simplification"], phase: "fin", lawId: lGuichet,
    dates: { projet: ago(330), parrainage: ago(300), deliberation: ago(270), vote: ago(26), fin: ago(19) }, delibDays: 244,
    result: { outcome: "adopted", votes: { maj: { p: 42, c: 13, a: 7 }, min: { p: 2, c: 1, a: 2 } }, electorate: 81, pourPct: 75.9, participationPct: 82.7, needMaj: 50, needQuo: 5, closedAt: ago(19), applied: "La loi entre dans le recueil." },
    versions: [[ago(330), "Version initiale", guichetText]] });
  prop({ title: "Transports en commun gratuits pour les moins de 18 ans", summary: "Bus, tram, métro et TER gratuits pour tous les mineurs, partout en France.",
    author: "Lea.T", themes: ["Transports", "Social"], tags: ["jeunesse", "gratuité", "mobilité"], phase: "projet", dates: { projet: ago(3) },
    versions: [[ago(3), "Version initiale", "Les transports en commun urbains et les TER sont gratuits pour toutes les personnes de moins de 18 ans.\n\nUne carte unique valable dans toute la France remplace les abonnements scolaires."]],
    notes: [{ type: "comment", author: "Karim.B", days: 2, text: "Bonne idée, mais qui paie ? Il faudrait ajouter un paragraphe sur le financement, sinon ça ne passera jamais le débat." }] });
  prop({ kind: "modif", target: { lawId: lGuichet, base: 1 }, title: "Étendre le guichet unique aux associations",
    summary: "Les associations employeuses font les mêmes démarches que les TPE : elles doivent avoir le même guichet.",
    author: "Mehdi.asso", themes: ["Économie", "Social"], tags: ["associations", "simplification"], phase: "projet", dates: { projet: ago(8) },
    versions: [[ago(8), "Version initiale", "Toutes les démarches d'une entreprise ou d'une association de moins de 10 salariés passent par un seul site et un seul conseiller référent.\n\nUne administration ne peut pas redemander un document déjà fourni à une autre.\n\nSans réponse sous deux mois, une demande est considérée comme acceptée.\n\nLes associations sans salarié peuvent aussi y faire leurs déclarations et leurs demandes de subvention."]],
    notes: [{ type: "comment", author: "Pierre_77", days: 6, text: "Porteur de la loi d'origine ici : je suis pour. Attention juste à ne pas surcharger les conseillers, il faudra des moyens en plus." }] });
  prop({ kind: "abrog", target: { lawId: lPub, base: 1 }, title: "Abroger l'interdiction des écrans publicitaires numériques",
    summary: "Laisser chaque commune décider, plutôt qu'une interdiction nationale.", author: "Nadia.com", themes: ["Économie"], tags: ["publicité", "communes", "commerce"],
    phase: "parrainage", dates: { projet: ago(40), parrainage: ago(12) }, parrains: 12,
    versions: [[ago(40), "Version initiale", "L'interdiction nationale pénalise les commerçants de centre-ville face aux grandes plateformes en ligne.\n\nLes écrans récents consomment beaucoup moins qu'au moment du vote de la loi.\n\nNous proposons d'abroger cette loi pour laisser chaque conseil municipal décider pour sa commune."]],
    notes: [{ type: "comment", author: "Sandrine_R", days: 25, text: "Laisser chaque commune décider, c'est surtout laisser les grandes enseignes faire pression ville par ville." }] });
  const base = { v: cst.n, params: cst.params, free: cst.free };
  prop({ kind: "const", constBase: base, title: "Allonger le vote à 10 jours", summary: "Une semaine, c'est court pour ceux qui travaillent en horaires décalés ou sont en déplacement.",
    author: "citoyenne_ana", themes: ["Constitution"], tags: ["règles", "participation"], phase: "deliberation",
    dates: { projet: ago(70), parrainage: ago(45), deliberation: ago(30) }, projetDays: 25, delibDays: 90, parrains: 50,
    versions: [[ago(70), "Version initiale", "Beaucoup d'inscrits ne peuvent pas voter pendant une semaine précise : travail de nuit, déplacements, vacances.\n\nDix jours permettent d'inclure deux week-ends complets, sans rallonger beaucoup le cycle.", { params: { ...cst.params, voteDays: 10 }, free: cst.free }]],
    notes: [{ type: "comment", author: "theo_m", days: 35, text: "Pour : avec deux week-ends, plus de jeunes pourront voter. Pendant la semaine on a cours." }] });
  prop({ kind: "const", constBase: base, is2027: true, title: "Mode campagne : délibération de 30 jours minimum", summary: "Pour que le cahier citoyen 2027 puisse être voté avant le premier tour.",
    author: "Karim.B", themes: ["Constitution"], tags: ["règles", "délibération", "2027"], phase: "projet", dates: { projet: ago(5) }, projetDays: Math.max(cst.params.projetMin, 21),
    versions: [[ago(5), "Version initiale", "Avec 90 jours minimum de délibération, aucune proposition déposée aujourd'hui ne sera votée avant le premier tour de la présidentielle.\n\nLe porteur garde le choix : il peut toujours prévoir 3 à 6 mois s'il le souhaite.", { params: { ...cst.params, delibMin: Math.min(30, cst.params.delibMax) }, free: cst.free }]],
    notes: [
      { type: "comment", author: "Pierre_77", days: 4, text: "Je comprends l'objectif, mais ça s'appliquerait à toutes les propositions, pas seulement à 2027. Il faudrait un article spécifique à la campagne." },
      { type: "comment", author: "Sandrine_R", days: 2, text: "D'accord si c'est temporaire, jusqu'au premier tour. Tu peux l'ajouter dans les principes ?" }
    ] });
  journal("Données d'exemple chargées (mode démo)");
}

function paras(t) { return String(t).split(/\n\s*\n/).map(s => s.trim()).filter(Boolean); }

// Utilisation directe : node server/seed.js
if (process.argv[1] && process.argv[1].endsWith("seed.js")) {
  const { ensureConstitution } = await import("./model.js");
  ensureConstitution();
  console.log(seedIfEmpty() ? "Exemples ajoutés." : "La base contient déjà des données : rien n'a été ajouté.");
}
