// Generates golden/corpus.json and golden/synthetic.json. Output is deterministic.
// Everything here is invented: it tests ranking mechanics and catches regressions, and says
// nothing about how well Nexus Brain works on a real company's data.
//   node scripts/generate-golden.mjs
import { writeFileSync } from "node:fs";

const ACME = ["alice", "bob", "patAcme"];

// Each topic: words people search with, one primary document per source, and rephrased
// questions that deliberately share no search word with those documents.
const TOPICS = [
  ["login", "SSO login failure", "SSO login troubleshooting guide", "Sessions drop after SAML redirect", ["why can't people get into the app", "users are locked out after single sign on", "authentication keeps kicking staff out"]],
  ["billing", "Billing export wrong totals", "Billing export design", "Invoice CSV rounding fix", ["the money figures in our download look off", "finance says the spreadsheet amounts disagree", "customer charges do not add up"]],
  ["rotation", "Signing key rotation overdue", "Key rotation runbook", "Automate secret rotation job", ["how often do we change credentials", "when do cryptographic secrets get replaced", "procedure for renewing tokens"]],
  ["onboarding", "New hire onboarding checklist gaps", "Onboarding handbook", "Seed accounts for onboarding", ["what should a new starter do on day one", "first week steps for joiners", "getting a recent recruit set up"]],
  ["roadmap", "Roadmap review actions", "Product roadmap 2027", "Roadmap page redesign", ["what are we shipping next year", "plans for upcoming quarters", "which big bets come after this release"]],
  ["incident", "Incident follow ups from outage", "Incident response process", "Add incident status banner", ["what do we do when production goes down", "who gets paged during an emergency", "steps for handling a service disruption"]],
  ["backup", "Nightly backup failing", "Backup and restore policy", "Verify backup checksums", ["how do we recover lost data", "where are database copies kept", "how long are archived snapshots retained"]],
  ["migration", "Database migration blocked", "Postgres migration plan", "Forward only migration runner", ["moving to the new data store", "steps to upgrade our storage engine", "when does the schema move happen"]],
  ["pricing", "Pricing page shows old plans", "Pricing strategy notes", "Update pricing table", ["how much do we charge customers", "what does the enterprise tier cost", "discount rules for large deals"]],
  ["security", "Security review findings", "Security policy", "Harden security headers", ["rules for protecting customer information", "what did the penetration testers find", "requirements for handling vulnerabilities"]],
  ["deployment", "Deployment pipeline flaky", "Deployment guide", "Canary deployment support", ["how do we ship code to production", "release steps for the web service", "why do our rollouts keep failing"]],
  ["hiring", "Hiring plan approvals", "Hiring process", "Careers page openings", ["how many engineers are we recruiting", "interview stages for candidates", "who signs off on new headcount"]],
  ["analytics", "Analytics dashboard stale", "Analytics event catalogue", "Add analytics tracking", ["why are the usage charts out of date", "which product metrics do we record", "numbers on the reporting screen are old"]],
  ["mobile", "Mobile app crash on start", "Mobile release checklist", "Fix mobile push tokens", ["the phone application dies when opened", "steps before publishing to the app stores", "android and ios build problems"]],
  ["compliance", "Compliance audit evidence", "Compliance controls", "Export compliance logs", ["what does the auditor need from us", "SOC 2 paperwork status", "proof we follow the regulations"]],
];
const SOURCES = ["jira", "wiki", "github"];

const documents = [];
const day = (n) => `2026-${String(1 + (n % 9)).padStart(2, "0")}-${String(1 + (n % 27)).padStart(2, "0")}`;

TOPICS.forEach(([word, jira, wiki, github], t) => {
  [jira, wiki, github].forEach((title, s) => {
    documents.push({
      id: `${SOURCES[s]}:${word}`,
      source: SOURCES[s],
      title,
      body: `${title}. Details about ${word}.`,
      updated: day(t + s),
      visibleTo: ACME,
    });
  });
  // Newest in each source, but they only mention the word in passing, so recency alone ranks them first.
  SOURCES.forEach((source, s) => {
    documents.push({
      id: `${source}:note-${word}`,
      source,
      title: `Weekly team update ${t + 1}`,
      body: `Meeting notes, holiday cover, office move and lunch rota. Someone also mentioned ${word} briefly.`,
      updated: `2026-10-${String(10 + ((t + s) % 18)).padStart(2, "0")}`,
      visibleTo: ACME,
    });
  });
});

const PRIVATE = [
  ["wiki:exec-comp", "Executive compensation review", ["alice"]],
  ["wiki:layoff-plan", "Restructuring plan draft", ["alice"]],
  ["wiki:acquisition", "Acquisition target shortlist", ["alice"]],
  ["wiki:board-notes", "Board meeting notes", ["alice"]],
  ["wiki:legal-dispute", "Legal dispute summary", ["alice"]],
];
for (const [id, title, visibleTo] of PRIVATE) {
  documents.push({ id, source: "wiki", title, body: `${title}. Restricted.`, updated: "2026-10-30", visibleTo });
}
const GLOBEX = ["patGlobex", "gus"];
TOPICS.slice(0, 5).forEach(([word], t) => {
  documents.push({
    id: `globex:${word}`,
    source: "wiki",
    title: `Globex ${word} plan`,
    body: `Globex notes about ${word}.`,
    updated: day(t),
    visibleTo: GLOBEX,
  });
});
documents.push({ id: "wiki:public-faq", source: "wiki", title: "Company FAQ", body: "Office address and holidays.", updated: "2026-05-05", visibleTo: [...ACME, "gina"] });

const cases = [];
const user = (i) => ACME[i % ACME.length];
const add = (tag, query, expected, extra = {}) =>
  cases.push({ id: `${tag}-${cases.length + 1}`, asUser: extra.asUser ?? user(cases.length), query, expected, forbidden: extra.forbidden ?? [], tags: [tag] });

// The mix below was fixed before any score was seen. 300 questions in all.

// 60: the exact title of a document, as someone pasting it would search.
for (let i = 0; i < 60; i += 1) {
  const topic = TOPICS[i % TOPICS.length];
  const s = Math.floor(i / TOPICS.length) % SOURCES.length;
  add("exact-title", topic[s + 1], [`${SOURCES[s]}:${topic[0]}`]);
}

// 90: everyday questions built from a document's own distinctive words.
const QUESTION_FORMS = [
  (title) => `what is the status of ${title.toLowerCase()}`,
  (title) => `tell me about ${title.toLowerCase()}`,
  (title) => `any news on ${title.toLowerCase()}?`,
];
for (let i = 0; i < 90; i += 1) {
  const topic = TOPICS[i % TOPICS.length];
  const s = (i + Math.floor(i / TOPICS.length)) % SOURCES.length;
  add("keyword", QUESTION_FORMS[i % QUESTION_FORMS.length](topic[s + 1]), [`${SOURCES[s]}:${topic[0]}`]);
}

// 40: rephrased questions sharing no search word with the document. Keyword search should miss these.
const paraphrases = TOPICS.flatMap(([word, , , , questions]) => questions.map((q) => [word, q]));
paraphrases.slice(0, 40).forEach(([word, query]) => add("paraphrase", query, [`wiki:${word}`]));

// 30: a broad question whose answer spans all three sources.
for (let i = 0; i < 30; i += 1) {
  const word = TOPICS[i % TOPICS.length][0];
  add("multi-source", i < 15 ? `everything about ${word}` : `${word} across all our tools`, SOURCES.map((s) => `${s}:${word}`));
}

// 40: must never return another company's or another person's documents.
TOPICS.slice(0, 5).forEach(([word]) => {
  for (let n = 0; n < 2; n += 1) {
    add("perm-other-company", `${word} plan`, [], { asUser: n === 0 ? "alice" : "bob", forbidden: [`globex:${word}`] });
    add("perm-other-company", `${word} ${n === 0 ? "status" : "notes"}`, [], {
      asUser: n === 0 ? "patGlobex" : "gus",
      forbidden: SOURCES.map((s) => `${s}:${word}`),
    });
  }
});
PRIVATE.forEach(([id, title]) => {
  add("perm-private", title, [], { asUser: "bob", forbidden: [id] });
  add("perm-private", title.split(" ")[0], [], { asUser: "patAcme", forbidden: [id] });
});
TOPICS.slice(0, 10).forEach(([word]) => {
  add("perm-guest", `${word} update`, [], { asUser: "gina", forbidden: SOURCES.map((s) => `${s}:${word}`) });
});

// 40: nothing in the corpus answers these. They cannot fail: the report counts how many return results.
const ABSENT = ["parking permits", "espresso machine", "snowboard trip", "bicycle storage", "printer toner", "yoga classes", "vending snacks", "aquarium cleaning", "window blinds", "fire drill", "umbrella stand", "plant watering", "pizza order", "karaoke night", "chess club", "gym discount", "ferry timetable", "tram passes", "laundry service", "piano lessons"];
ABSENT.forEach((topic) => {
  add("no-answer", `where do I find ${topic}`, []);
  add("no-answer", topic, []);
});

const description = "SYNTHETIC. Invented documents and questions that test ranking mechanics and catch regressions; they say nothing about quality on real company data.";
writeFileSync("golden/corpus.json", `${JSON.stringify({ version: 1, description, documents }, null, 2)}\n`);
// Floor for searching with the question alone, which cannot find rephrased questions. It only
// catches things getting worse. With recorded rewrites, the eval also requires the 0.85 target.
const minRecallAtK = 0.8;
writeFileSync("golden/synthetic.json", `${JSON.stringify({ version: 1, description, minRecallAtK, cases }, null, 2)}\n`);
console.log(`${documents.length} documents, ${cases.length} questions`);
const counts = {};
for (const c of cases) counts[c.tags[0]] = (counts[c.tags[0]] ?? 0) + 1;
console.log(counts);
