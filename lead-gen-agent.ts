#!/usr/bin/env npx ts-node
/**
 * CoreIT Autonomous Lead Gen Agent
 * - Pulls target company domains from seed list
 * - Queries Hunter.io for CIO/CTO/IT Director emails
 * - Skips already-contacted leads
 * - Sends Email #1 via Resend immediately
 * - Schedules Email #2 (day 3) and Email #3 (day 10)
 * - Logs all contacts to contacted.json
 */

import fs from "fs";
import path from "path";
import https from "https";

const HUNTER_API_KEY = "7b269a2b7efdc990bd866124ab9e9822b917d8f1";
const RESEND_API_KEY = process.env.RESEND_API_KEY!;
const FROM = "Gal from CoreIT <sales@coreitportal.com>";
const REPLY_TO = "sales@coreitportal.com";
const LOG_FILE = path.join(__dirname, "contacted.json");

const TARGET_TITLES = [
  "cio", "cto", "chief information officer", "chief technology officer",
  "it director", "it manager", "vp of it", "head of it",
];

// Add new target domains here each week
const TARGET_DOMAINS = [
  "invisus.com", "wpglobalpartners.com", "fortsystems.com",
  "skyitgroup.com", "nodalexchange.com", "virima.com",
  "transcepta.com", "mammothfs.com", "omni-response.com",
  "informativ.com", "doforms.com", "stratus-services.com",
  "advisorengine.com", "hei-consulting.com", "ktllp.cpa",
  "tacticom.com", "ladingcorporation.com", "5qpartners.com",
  "slickdigital.io", "athalonlabs.com", "mrets.org",
  "cognizancetech.com",
  // Add more domains below:
];

const EMAIL_1 = (firstName: string) => ({
  subject: "who has the MacBook Pro?",
  text: `Hey ${firstName},

Quick genuine question — if someone asked you right now which employees have access to which SaaS tools, how long would it take to find out?

For most IT leaders at companies your size, it's either a spreadsheet, a memory exercise, or a prayer.

I built CoreIT to fix exactly that — one portal for employee software licenses, hardware assets, and onboarding/offboarding. Setup takes less than a day.

No sales call. Just try it free:
→ coreitportal.com

— Gal
Founder, CoreIT`,
});

const EMAIL_2 = (firstName: string) => ({
  subject: "the offboarding problem",
  text: `Hey ${firstName},

One thing I keep hearing from IT folks at small companies:
someone leaves, and two weeks later they still have Slack access. Sometimes longer.

It's not negligence — it's that offboarding is manual, scattered, and nobody owns it end-to-end.

CoreIT gives you a single place to see every tool an employee has, and removes access in one pass when they're gone.

Worth 10 minutes?
→ coreitportal.com (free, no card)

— Gal`,
});

const EMAIL_3 = (firstName: string) => ({
  subject: "closing the loop",
  text: `Hey ${firstName},

Not going to keep pinging you — just wanted to close the loop.

If IT visibility isn't a priority right now, totally understood.
If it is and the timing just wasn't right, CoreIT will be here.

Free trial's always open: coreitportal.com

Either way, good luck with everything.

— Gal`,
});

function get(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(JSON.parse(data)));
    }).on("error", reject);
  });
}

function post(url: string, body: any, headers: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...headers },
    };
    const [protocol, , host, ...pathParts] = url.split("/");
    const req = https.request({ hostname: host, path: "/" + pathParts.join("/"), ...options }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function loadContacted(): Set<string> {
  if (!fs.existsSync(LOG_FILE)) return new Set();
  const data = JSON.parse(fs.readFileSync(LOG_FILE, "utf-8"));
  return new Set(data);
}

function saveContacted(contacted: Set<string>) {
  fs.writeFileSync(LOG_FILE, JSON.stringify([...contacted], null, 2));
}

function isTargetTitle(title: string): boolean {
  const lower = title.toLowerCase();
  return TARGET_TITLES.some((t) => lower.includes(t));
}

function scheduledAt(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

async function sendEmail(to: string, subject: string, text: string, scheduleAt?: string) {
  const body: any = { from: FROM, to: [to], reply_to: [REPLY_TO], subject, text };
  if (scheduleAt) body.scheduled_at = scheduleAt;

  const url = "https://api.resend.com/emails";
  const [, , host, ...pathParts] = url.split("/");
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: "api.resend.com",
      path: "/emails",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function processDomain(domain: string, contacted: Set<string>): Promise<number> {
  const url = `https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${HUNTER_API_KEY}&limit=10`;
  const result = await get(url);
  const emails = result?.data?.emails ?? [];

  let added = 0;
  for (const person of emails) {
    const email = person.value;
    const title = person.position ?? "";
    const firstName = person.first_name ?? "there";

    if (!email || contacted.has(email)) continue;
    if (!isTargetTitle(title)) continue;

    console.log(`→ Found: ${firstName} (${title}) at ${domain} — ${email}`);

    // Send Email #1 now
    await sendEmail(email, EMAIL_1(firstName).subject, EMAIL_1(firstName).text);
    // Schedule Email #2 in 3 days
    await sendEmail(email, EMAIL_2(firstName).subject, EMAIL_2(firstName).text, scheduledAt(3));
    // Schedule Email #3 in 10 days
    await sendEmail(email, EMAIL_3(firstName).subject, EMAIL_3(firstName).text, scheduledAt(10));

    contacted.add(email);
    added++;

    // Respect Hunter rate limits
    await new Promise((r) => setTimeout(r, 500));
  }

  return added;
}

async function main() {
  console.log(`\n🤖 CoreIT Lead Gen Agent — ${new Date().toISOString()}`);
  const contacted = loadContacted();
  console.log(`Already contacted: ${contacted.size} leads`);

  let totalAdded = 0;
  for (const domain of TARGET_DOMAINS) {
    try {
      const added = await processDomain(domain, contacted);
      totalAdded += added;
      if (added > 0) console.log(`  ✓ ${domain}: ${added} new leads`);
      else console.log(`  — ${domain}: no new targets`);
    } catch (err) {
      console.error(`  ✗ ${domain}: error — ${err}`);
    }
  }

  saveContacted(contacted);
  console.log(`\nDone. ${totalAdded} new leads added this run.\n`);
}

main().catch(console.error);
