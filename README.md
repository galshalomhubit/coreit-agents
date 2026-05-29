# CoreIT Agents

Autonomous lead gen & outreach agents for CoreIT.

## lead-gen-agent.ts

Runs weekly. For each target domain:
1. Queries Hunter.io for CIO/CTO/IT Director emails
2. Skips already-contacted leads (tracked in contacted.json)
3. Sends Email #1 via Resend immediately
4. Schedules Email #2 (day 3) and Email #3 (day 10)

### Env vars required
- `RESEND_API_KEY`

### Add new target domains
Edit the `TARGET_DOMAINS` array in `lead-gen-agent.ts`.
