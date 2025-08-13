// roundRobin.js
import { LinearClient } from "@linear/sdk";
import fetch from "node-fetch"; // SDK references global fetch in Node18+, but we import to be safe.

const {
  LINEAR_API_KEY,
  LINEAR_TEAM_ID,
  ASSIGNEE_EMAILS,
  WORKSPACE_SLUG,
} = process.env;

if (!LINEAR_API_KEY || !LINEAR_TEAM_ID || !ASSIGNEE_EMAILS || !WORKSPACE_SLUG) {
  console.error("Missing required env vars.");
  process.exit(1);
}

const client = new LinearClient({ apiKey: LINEAR_API_KEY });

// Helper: get user map by email (id + name + profile URL)
async function getUserMapByEmail(emails) {
  const users = await client.users();
  const byEmail = new Map();
  for (const u of users.nodes) {
    if (!u.email) continue;
    byEmail.set(u.email.toLowerCase(), {
      id: u.id,
      name: u.name,
      // Linear will turn this URL into an @mention when used in Markdown comments
      profileUrl: u.url ?? `https://linear.app/${WORKSPACE_SLUG}/profiles/${encodeURIComponent(u.displayName || u.name)}`,
    });
  }
  // Validate everyone exists
  const missing = emails.filter(e => !byEmail.has(e.toLowerCase()));
  if (missing.length) {
    throw new Error(`These emails are not Linear users: ${missing.join(", ")}`);
  }
  return byEmail;
}

async function main() {
  const emails = ASSIGNEE_EMAILS.split(",").map(s => s.trim()).filter(Boolean);
  const userMap = await getUserMapByEmail(emails);
  const assignees = emails.map(e => userMap.get(e.toLowerCase())); // in rotation order

  // Fetch unassigned TRIAGE issues for the team
  // Using SDK filter: state.type = "triage", assignee null
  const issuesConn = await client.issues({
    filter: {
      team: { id: { eq: LINEAR_TEAM_ID } },
      assignee: { null: true },
      state: { type: { eq: "triage" } },
    },
    orderBy: "createdAt",
    first: 100, // adjust if you expect big bursts
  });

  for (const issue of issuesConn.nodes) {
    // Deterministic, stateless rotation based on per-team issue number
    // (BLA-123 -> 123). SDK exposes `number` field.
    const idx = issue.number % assignees.length;
    const target = assignees[idx];

    // Assign the issue
    await client.issueUpdate(issue.id, { assigneeId: target.id });

    // Comment with a true @mention via profile URL (Linear converts to @Name)
    const body =
      `${target.profileUrl} please triage this issue in the next 48 hours.\n\n` +
      `_(This is assigned automatically in a round-robin based on inbound tickets.)_`;

    await client.commentCreate({
      issueId: issue.id,
      body,
    });

    console.log(`Assigned ${issue.identifier} to ${target.name}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
