// scripts/roundRobin.js
import { LinearClient } from "@linear/sdk";

const {
  LINEAR_API_KEY,
  LINEAR_TEAM_ID,
  ASSIGNEE_EMAILS, // comma-separated emails in rotation order
  WORKSPACE_SLUG,  // optional; improves fallback mention link
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
  if (missing.length) {
    throw new Error(`Not Linear users (by email): ${missing.join(", ")}`);
  }
  return byEmail;
}

async function postCommentWithMention(issueId, target) {
  // 1) Preferred: rich-text @mention using ProseMirror bodyData
  try {
    await client.createComment({
      issueId,
      bodyData: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              // NOTE: schema differences exist; most workspaces accept just { id }
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
    console.log(`  ✅ Comment posted via bodyData mention for ${target.name}`);
    return;
  } catch (e) {
    console.warn(`  ⚠️ bodyData mention failed: ${e?.message || e}`);
  }

  // 2) Fallback: Markdown link to /people/<id> (often renders as a person chip; always clickable)
  try {
    const slug = WORKSPACE_SLUG || "<your-slug>";
    const profileUrl = `https://linear.app/${slug}/people/${target.id}`;
    const body =
      `[${target.name}](${profileUrl}) please triage this issue in the next 48 hours.\n\n` +
      `_(This is assigned automatically in a round-robin based on inbound tickets.)_`;
    await client.createComment({ issueId, body });
    console.log(`  ✅ Comment posted via Markdown fallback for ${target.name}`);
    return;
  } catch (e) {
    console.error(`  ❌ Fallback Markdown comment also failed: ${e?.message || e}`);
    throw e;
  }
}

async function main() {
  const emails = ASSIGNEE_EMAILS.split(",").map(s => s.trim()).filter(Boolean);
  if (emails.length === 0) {
    console.error("ASSIGNEE_EMAILS is empty after parsing.");
    process.exit(1);
  }
  console.log(`Rotation order (${emails.length}): ${emails.join(" -> ")}`);

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

  const issues = issuesConn.nodes || [];
  console.log(`Found ${issues.length} unassigned triage issue(s) for team ${LINEAR_TEAM_ID}.`);

  for (const issue of issues) {
    try {
      const idx = issue.number % assignees.length;
      const target = assignees[idx];
      console.log(`- ${issue.identifier}: assigning to ${target.name} (${target.id}) [idx=${idx}]`);

      // Assign the issue
      await client.updateIssue(issue.id, { assigneeId: target.id });
      console.log(`  ✅ Assigned ${issue.identifier} to ${target.name}`);

      // Post the comment (rich-text mention, then Markdown fallback)
      await postCommentWithMention(issue.id, target);

      // Optional: ensure they "follow" for extra notifications (ignore if not supported)
      try {
        await client.updateIssue(issue.id, { subscriberIds: [target.id] });
        console.log(`  ✅ Added ${target.name} as follower`);
      } catch { /* ignore */ }

    } catch (err) {
      console.error(`  ❌ Failed on ${issue.identifier}: ${err?.message || err}`);
    }
  }

  if (issues.length === 0) {
    console.log("Nothing to do. Exiting.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
