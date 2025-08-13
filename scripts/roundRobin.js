// scripts/roundRobin.js
import { LinearClient } from "@linear/sdk";

const {
  LINEAR_API_KEY,
  LINEAR_TEAM_ID,
  ASSIGNEE_EMAILS, // comma-separated emails in rotation order
} = process.env;

if (!LINEAR_API_KEY || !LINEAR_TEAM_ID || !ASSIGNEE_EMAILS) {
  console.error("Missing required env vars: LINEAR_API_KEY, LINEAR_TEAM_ID, ASSIGNEE_EMAILS");
  process.exit(1);
}

const client = new LinearClient({ apiKey: LINEAR_API_KEY });

async function getUserMapByEmail(emails) {
  const users = await client.users();
  const byEmail = new Map();
  for (const u of users.nodes) {
    if (!u?.email) continue;
    byEmail.set(u.email.toLowerCase(), { id: u.id, name: u.name });
  }
  const missing = emails.filter(e => !byEmail.has(e.toLowerCase()));
  if (missing.length) throw new Error(`Not Linear users (by email): ${missing.join(", ")}`);
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

  // Unassigned issues in TRIAGE for this team (newest first)
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

      // Assign
      await client.updateIssue(issue.id, { assigneeId: target.id });

      // Comment with a real @mention using ProseMirror bodyData (OBJECT, no `type:"user"` in attrs)
      await client.createComment({
        issueId: issue.id,
        bodyData: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "mention", attrs: { id: target.id } },
                { type: "text", text: ", please triage this issue in the next 48 hours." }
              ]
            },
            {
              type: "paragraph",
              content: [
                { type: "text", text: "(This is assigned automatically in a round-robin based on inbound tickets.)" }
              ]
            }
          ]
        }
      });

      // (Optional) ensure they follow the issue for extra notifications
      try {
        await client.updateIssue(issue.id, { subscriberIds: [target.id] });
      } catch { /* ignore if not supported */ }

      console.log(`Assigned ${issue.identifier} to ${target.name} (${target.id}) and mentioned them`);
    } catch (err) {
      console.error(`Failed on ${issue.identifier}: ${err?.message || err}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
