// Spawned by store.test.ts: opens the shared store in a second process and
// races a DM creation against the parent. Prints the conversation id.
import { createTeamStore } from "../src/store";

const [rootDir, teamId, userId, peerId, requestId] = process.argv.slice(2);
if (!rootDir || !teamId || !userId || !peerId || !requestId) {
  console.error("usage: concurrent-dm ROOT TEAM USER PEER REQUEST");
  process.exit(2);
}
const store = createTeamStore({ rootDir });
try {
  const view = store.createDm({ team_id: teamId, user_id: userId }, requestId, {
    peer_user_id: peerId,
  });
  console.log(view.conversation.conversation_id);
} finally {
  store.close();
}
