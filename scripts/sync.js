/**
 * sync.js
 * Reads #workflow_troubleshoot, passes messages to Claude,
 * extracts confirmed-fixed issues, and writes issues.json.
 *
 * MERGE STRATEGY: existing issues.json is the source of truth.
 * Claude can only ADD new issue IDs — it can never delete existing ones.
 * This prevents non-deterministic Claude runs from dropping entries.
 */

const { WebClient } = require('@slack/web-api');
const fs = require('fs');

const SLACK_TOKEN    = process.env.SLACK_BOT_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const CHANNEL_ID     = 'C09FFH560A1';   // #workflow_troubleshoot
const LOOKBACK_DAYS  = 1;               // Only scan the last 24 hours — script runs once daily at noon CT

// ─────────────────────────────────────────────
//  1. Fetch messages + thread replies from Slack
// ─────────────────────────────────────────────
async function fetchMessages() {
  const client  = new WebClient(SLACK_TOKEN);
  const oldest  = String(Math.floor((Date.now() - LOOKBACK_DAYS * 86400 * 1000) / 1000));
  const threads = [];
  let   cursor;

  console.log(`Fetching messages from the last ${LOOKBACK_DAYS} days...`);

  do {
    const res = await client.conversations.history({
      channel: CHANNEL_ID,
      oldest,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });

    for (const msg of res.messages || []) {
      if (!msg.text || msg.subtype === 'channel_join') continue;

      let replies = [];
      if (msg.thread_ts && msg.reply_count > 0) {
        try {
          const thread = await client.conversations.replies({
            channel: CHANNEL_ID,
            ts: msg.thread_ts,
            limit: 100,
          });
          replies = (thread.messages || []).slice(1); // skip parent
        } catch (e) {
          console.warn(`  Could not fetch thread ${msg.thread_ts}: ${e.message}`);
        }
      }

      threads.push({ parent: msg, replies });
    }

    cursor = res.response_metadata?.next_cursor;
  } while (cursor);

  console.log(`  Found ${threads.length} messages/threads.`);
  return threads;
}

// ─────────────────────────────────────────────
//  2. Format for Claude
// ─────────────────────────────────────────────
function formatForClaude(threads) {
  return threads.map(({ parent, replies }) => {
    const ts   = new Date(parseFloat(parent.ts) * 1000).toISOString().split('T')[0];
    const body = `[${ts}] ${parent.text || ''}`;
    const reps = replies
      .map(r => {
        const rts = new Date(parseFloat(r.ts) * 1000).toISOString().split('T')[0];
        return `  > [${rts}] ${r.text || ''}`;
      })
      .join('\n');
    return reps ? `${body}\n${reps}` : body;
  }).join('\n\n---\n\n');
}

// ─────────────────────────────────────────────
//  3. Ask Claude to extract fixed issues
// ─────────────────────────────────────────────
async function extractIssues(slackContent) {
  console.log('Sending to Claude for extraction...');

  const systemPrompt = `You are parsing Slack messages from #workflow_troubleshoot at Newzip, a real estate tech company. 
This channel is used to report and resolve HubSpot workflow issues affecting home advisors (HAs) and transaction coordinators (TCs).

Your job: identify all issues that have been CONFIRMED AS FIXED. An issue is confirmed fixed when someone explicitly says it is resolved, updated, fixed, turned off, or otherwise closed — not just that they are "looking into it."

For each confirmed-fixed issue, return a JSON object with these exact fields:
- id: string, sequential like "WF-001" assigned oldest-first
- title: string, one concise line describing what broke
- desc: string, 2–3 sentences explaining what the issue was, who was affected, and root cause if known
- workaround: string, one sentence — what HAs should do for leads that fell in the impact window
- tag: one of exactly: "tasks" | "emails" | "sms" | "routing"
- impactStart: "YYYY-MM-DD" — your best estimate of when the issue first started affecting leads (use the date the issue was first reported if unknown)
- impactEnd: "YYYY-MM-DD" — date the fix was confirmed complete
- fixedDate: "YYYY-MM-DD" — same as impactEnd
- fixedBy: string, full name of the person who fixed it

Important rules:
- Only include issues that are CONFIRMED FIXED. Do not include open/ongoing issues.
- If root cause was never stated, describe the symptom clearly.
- Return ONLY a valid JSON array with no markdown formatting, no code fences, no explanation. Just the raw JSON array.
- If there are no confirmed-fixed issues, return an empty array: []`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Here are the Slack messages from #workflow_troubleshoot (newest first):\n\n${slackContent}`,
        },
      ],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Claude API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const text = data.content?.[0]?.text?.trim() || '[]';

  // Robust extraction: find the JSON array anywhere in the response,
  // even if Claude prefixes it with reasoning text.
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) {
    console.error('Failed to find JSON array in Claude response:', text);
    throw new Error('Claude did not return a JSON array');
  }

  try {
    return JSON.parse(match[0]);
  } catch (e) {
    console.error('Failed to parse Claude response:', match[0]);
    throw new Error('Claude did not return valid JSON');
  }
}

// ─────────────────────────────────────────────
//  4. Load existing issues.json (if it exists)
// ─────────────────────────────────────────────
function loadExistingIssues() {
  try {
    const raw = fs.readFileSync('issues.json', 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.issues || [];
  } catch (e) {
    // File doesn't exist yet or is malformed — start fresh
    return [];
  }
}

// ─────────────────────────────────────────────
//  5. Merge: existing issues are never deleted.
//     Claude can only add new IDs.
// ─────────────────────────────────────────────
function mergeIssues(existing, fromClaude) {
  const merged = new Map(existing.map(i => [i.id, i]));

  let added = 0;
  for (const issue of fromClaude) {
    if (!merged.has(issue.id)) {
      merged.set(issue.id, issue);
      added++;
    }
    // If the ID already exists, keep the existing entry.
    // This prevents Claude's non-determinism from overwriting
    // manually-curated or previously-correct entries.
  }

  if (added > 0) {
    console.log(`  Added ${added} new issue(s) from this sync.`);
  } else {
    console.log('  No new issues found — existing entries preserved.');
  }

  // Sort by ID so the file is stable and readable
  return Array.from(merged.values()).sort((a, b) => a.id.localeCompare(b.id));
}

// ─────────────────────────────────────────────
//  6. Main
// ─────────────────────────────────────────────
async function main() {
  if (!SLACK_TOKEN)   throw new Error('SLACK_BOT_TOKEN is not set');
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY is not set');

  const existing     = loadExistingIssues();
  console.log(`  Loaded ${existing.length} existing issue(s) from issues.json.`);

  const threads      = await fetchMessages();

  if (threads.length === 0) {
    console.log('  No new messages in the last 24 hours. Nothing to do.');
    return;
  }

  const slackContent = formatForClaude(threads);
  const fromClaude   = await extractIssues(slackContent);

  console.log(`  Claude extracted ${fromClaude.length} confirmed-fixed issue(s).`);

  const merged = mergeIssues(existing, fromClaude);
  console.log(`  Total after merge: ${merged.length} issue(s).`);

  const output = {
    lastUpdated: new Date().toISOString(),
    issues: merged,
  };

  fs.writeFileSync('issues.json', JSON.stringify(output, null, 2));
  console.log('  Written to issues.json');
}

main().catch(err => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
