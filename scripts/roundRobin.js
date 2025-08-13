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
    byEmail.set(u.email.toLowerCase(), {
      id: u.id,
      name: u.name,
      url: u.url,
      displayName: u.displayName, // often the /profiles handle (e.g., "alex.tang")
      email: u.email.toLowerCase(),
    });
  }
  const missing = emails.filter(e => !byEmail.has(e.toLowerCase()));
  if (missing.length) throw new Error(`Not Linear users (by email): ${missing.join(", ")}`);
  return byEmail;
}

function profileUrlFromHandle(handle) {
  return `https://linear.app/${WORKSPACE_SLUG}/profiles/${handle}`;
}

async function ensureProfileUrlForUserId(userId, fallbackHandle) {
  // Fetch fresh user fields to get displayName (handle)
  const { user } = await client.user(userId);
  if (user?.displayName) return profileUrlFromHandle(user.displayName);
  if (user?.url && /\/profiles\/[^/]+$/i.test(user.url)) return user.url;
  // Last resort: try a derived handle (may not ping if wrong, but link remains clickable)
  return profileUrlFromHandle((fallbackHandle || "there").toLowerCase());
}

async function postMentionComment(issueId, targetUser) {
  // Build a /profiles/<handle> URL; Linear auto-converts raw URL to a chip-style @mention
  const profileUrl = await ensureProfileUrlForUserId(
    targetUser.id,
    targetUser.email?.split("@")[0]
  );

  // Friendly message with raw URL mention first
  const body =
    `Hi ${profileUrl}, please triage this issue in the next 48 hours.\n\n` +
    `_(This is assigned automatically in a round-robin based on inbound tickets.)_`;

  try {
    await client.createComment({ issueId, body });
    console.log(`  ✅ Friendly comment posted via /profiles mention`);
    return;
  } catch (e) {
    console.warn(`  ⚠️ Raw URL mention failed: ${e?.message || e}`);
  }

  // Fallback: Markdown link (clickable; may not @-ping if not auto-converted)
  try {
    const fallbackBody =
      `Hi [${targetUser.name}](${profileUrl}), please triage this issue in the next 48 hours.\n\n` +
      `_(This is assigned automatically in a round-robin based on inbound tickets.)_`;
    await client.createComment({ issueId, body: fallbackBody });
    console.log(`  ✅ Friendly comment posted via Markdown fallback`);
  } catch (e) {
    console.error(`  ❌ Markdown fallback failed: ${e?.message || e}`);
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

      // Assign
      await client.updateIssue(issue.id, { assigneeId: target.id });
      console.log(`  ✅ Assigned ${issue.identifier} to ${target.name}`);

      // Comment (friendly greeting + @mention)
      await postMentionComment(issue.id, target);

      // Optional: ensure they follow for extra notifications (ignore if not supported)
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
