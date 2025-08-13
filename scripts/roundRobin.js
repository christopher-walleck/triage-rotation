// scripts/roundRobin.js
import { LinearClient } from "@linear/sdk";

const {
  LINEAR_API_KEY,
  LINEAR_TEAM_ID,
  ASSIGNEE_EMAILS, // comma-separated emails in rotation order
  WORKSPACE_SLUG,  // e.g. "hooglee"
} = process.env;

if (!LINEAR_API_KEY || !LINEAR_TEAM_ID || !ASSIGNEE_EMAILS) {
  console.error("Missing required env vars: LINEAR_API_KEY, LINEAR_TEAM_ID, ASSIGNEE_EMAILS");
  process.exit(1);
}
if (!WORKSPACE_SLUG) {
  console.error("Missing WORKSPACE_SLUG (e.g., 'hooglee'). Add it as a repo variable.");
  process.exit(1);
}

const client = new LinearClient({ apiKey: LINEAR_API_KEY });

async function getUserMapByEmail(emails) {
  const users = await client.users();
  const byEmail = new Map();
  for (const u of users.nodes) {
    if (!u?.email) continue;
    // We'll also keep the user id to build profile URLs
    byEmail.set(u.email.toLowerCase(), { id: u.id, name: u.name });
  }
  const missing = emails.filter(e => !byEmail.has(e.toLowerCase()));
  if (missing.length) {
    throw new Error(`Not Linear users (by email): ${missing.join(", ")}`);
  }
  return byEmail;
}

async function main() {
  const emails = ASSIGNEE_EMAILS.split(",").map(s => s.trim()).filter(Boolean);
  if (emails.length === 0) {
    console.error("ASSIGNEE_EMAILS is empty after parsing.");
    process.exit(1);
  }

  const userMap = await getUserMapByEmail(emails);
  const assignees = emails.map(e => userMap.get(e.toLowerCase())); // rotation order

  // Fetch unassigned issues in TRIAGE for this team (newest first)
  const issuesConn = await client.issues({
    filter: {
      team: { id: { eq: LINEAR_TEAM_ID } },
      assignee: { null: true },
      state: { type: { eq: "triage" } },
    },
    orderBy: "createdAt",
    first: 100,
  });

  for (const issue of issuesConn.nodes) {
    try {
      const idx = issue.number % assignees.length;
      const target = assignees[idx];

      // Assign the issue
      await client.updateIssue(issue.id, { assigneeId: target.id });

      // Comment with an @mention via profile URL (Linear converts this to a real mention)
      const profileUrl = `https://linear.app/${WORKSPACE_SLUG}/profiles/${target.id}`;
      const body =
        `${profileUrl} please triage this issue in the next 48 hours.\n\n` +
        `_(This is assigned automatically in a round-robin based on inbound tickets.)_`;

      await client.createComment({
        issueId: issue.id,
        body,
      });

      console.log(`Assigned ${issue.identifier} to ${target.name}`);
    } catch (err) {
      console.error(`Failed on ${issue.identifier}:`, err?.message || err);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
