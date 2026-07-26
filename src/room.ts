/**
 * @module room
 * The `frontdesk` capability as a guest-room DOOR, plus rooms that grant it.
 *
 * A guest with the frontdesk door reaches the scheduler (whats-next / claim /
 * release) through a unix socket to `frontdeskd` (scripts/frontdeskd.ts), which
 * holds the read-plane credential. The guest never holds a GitHub or DB key —
 * "exactly this capability, nothing ambient". A guest WITHOUT it is told, by
 * name, that Front Desk is absent — it can't be hallucinated into a success.
 */

import {
  capabilityPreamble,
  deniedDoors,
  deniedDoorSection,
  expandRoom,
  grantedDoorLines,
} from "@bounded-systems/guest-room";

/** The doors the consumer's rooms can furnish. `frontdesk` is ours; the rest are
 *  the org's existing capability doors, shown so a worker room composes naturally. */
export const CATALOG = {
  frontdesk: {
    flag: "--frontdesk",
    inBox: "/run/frontdeskd.sock",
    env: "FRONTDESKD_SOCK",
    hostDefault: "/tmp/frontdeskd.sock",
    grants: "Front Desk scheduling (read plane)",
    use: "Ask 'what should I work on?' and claim/release work through the front-desk door (whats-next / claim / release). The broker holds the read-plane credential; you never do.",
    deny: "No Front Desk here; relaunch with --frontdesk — you cannot pick or claim work without it.",
  },
  keeper: {
    flag: "--keeper", inBox: "/run/keeperd.sock", env: "KEEPERD_SOCK", hostDefault: "/tmp/keeperd.sock",
    grants: "signed git writes", use: "Route every git write through the keeper door.",
    deny: "No git-write authority here; relaunch with --keeper.",
  },
  net: {
    flag: "--net", inBox: "/run/netd.sock", env: "NETD_SOCK", hostDefault: "/tmp/netd.sock",
    grants: "policed egress", use: "All egress goes through the net door.",
    deny: "No network here; relaunch with --net.",
  },
};

/** Rooms — named bundles for a kind of work. */
export const ROOMS = {
  // A planning agent: consult Front Desk and lease work, nothing else.
  planner: { doors: ["frontdesk"], about: "consult Front Desk, claim/release work — no writes, no egress" },
  // A worker: pick work at the desk, then implement + push it.
  worker: { doors: ["frontdesk", "keeper", "net"], about: "claim at the desk, then edit/commit/push" },
};

/** Render the per-launch rulebook a room hands the agent (granted + denied by name). */
export function rulebook(room: string, env: NodeJS.ProcessEnv = process.env): string {
  const granted = expandRoom(ROOMS, CATALOG, room, env);
  const denied = deniedDoors(CATALOG, new Set(granted.map((d) => d.name)));
  return [
    ...capabilityPreamble(room),
    "",
    "GRANTED:",
    ...grantedDoorLines(granted),
    "",
    ...deniedDoorSection(denied),
  ].join("\n");
}
