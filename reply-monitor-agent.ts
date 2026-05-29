#!/usr/bin/env npx ts-node
/**
 * CoreIT Reply Monitor Agent
 * - Checks Resend for emails that received replies to the cold outreach campaign
 * - Logs new replies to replies.json
 * - Sends a summary notification email to the founder
 */

import https from "https";
import fs from "fs";
import path from "path";

const RESEND_API_KEY = process.env.RESEND_API_KEY!;
const FOUNDER_EMAIL = "gal.shalom@coreitportal.com";
const FROM = "CoreIT Agent <sales@coreitportal.com>";
const REPLIES_LOG = path.join(__dirname, "replies.json");

function request(method: string, hostname: string, path: string, body?: any, headers: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = https.request({
      method,
      hostname,
      path,
      headers: {
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function loadReplies(): Set<string> {
  if (!fs.existsSync(REPLIES_LOG)) return new Set();
  const data = JSON.parse(fs.readFileSync(REPLIES_LOG, "utf-8"));
  return new Set(data);
}

function saveReplies(replies: Set<string>) {
  fs.writeFileSync(REPLIES_LOG, JSON.stringify([...replies], null, 2));
}

async function getRecentEmails() {
  const result = await request("GET", "api.resend.com", "/emails?limit=100", undefined, {
    Authorization: `Bearer ${RESEND_API_KEY}`,
  });
  return result?.data ?? [];
}

async function sendNotification(newReplies: { email: string; name: string }[]) {
  const list = newReplies.map((r) => `• ${r.name} (${r.email})`).join("\n");
  const body = {
    from: FROM,
    to: [FOUNDER_EMAIL],
    subject: `🎯 ${newReplies.length} new reply${newReplies.length > 1 ? "s" : ""} to your cold outreach`,
    text: `Hey Gal,\n\nYou got ${newReplies.length} new reply${newReplies.length > 1 ? "s" : ""} to your CoreIT cold outreach campaign:\n\n${list}\n\nLog in to sales@coreitportal.com to respond — aim to reply within the hour.\n\n— CoreIT Agent`,
  };
  await request("POST", "api.resend.com", "/emails", body, {
    Authorization: `Bearer ${RESEND_API_KEY}`,
  });
}

async function main() {
  console.log(`\n🤖 CoreIT Reply Monitor — ${new Date().toISOString()}`);
  const knownReplies = loadReplies();
  const emails = await getRecentEmails();

  const campaignEmails = emails.filter((e: any) =>
    e.tags?.some((t: any) => t.name === "campaign" && t.value === "cold-outreach-1")
  );

  console.log(`Found ${campaignEmails.length} campaign emails`);

  // Check which ones got replies (last_event includes 'replied' or check via Resend events)
  const newReplies: { email: string; name: string }[] = [];

  for (const email of campaignEmails) {
    const emailId = email.id;
    if (knownReplies.has(emailId)) continue;

    // Get full email details to check events
    const detail = await request("GET", "api.resend.com", `/emails/${emailId}`, undefined, {
      Authorization: `Bearer ${RESEND_API_KEY}`,
    });

    const events: string[] = detail?.last_event ? [detail.last_event] : [];
    const replied = events.includes("replied") || detail?.reply_to_message_id;

    if (replied) {
      const recipient = Array.isArray(detail.to) ? detail.to[0] : detail.to;
      newReplies.push({ email: recipient, name: recipient.split("@")[0] });
      knownReplies.add(emailId);
      console.log(`  → Reply detected from: ${recipient}`);
    }
  }

  if (newReplies.length > 0) {
    await sendNotification(newReplies);
    console.log(`Sent notification for ${newReplies.length} new replies`);
  } else {
    console.log("No new replies detected");
  }

  saveReplies(knownReplies);
  console.log("Done.\n");
}

main().catch(console.error);
