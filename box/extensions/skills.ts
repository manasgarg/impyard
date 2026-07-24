/**
 * roster skills — point pi at the host-provisioned skills checkout.
 *
 * The host mounts a writable clone of the worker's skills repo at
 * $HOME/skills (src/worker/skills.rs); edits land via skill_push. pi
 * implements the Agent Skills format natively: given the path, it parses
 * each skill's frontmatter, compiles the name + description index into
 * the system prompt, and loads bodies on demand. This extension's entire
 * job is answering resources_discover with that path — when the mount is
 * absent (skills provisioning degraded), it stays silent and the run
 * proceeds without.
 */

const SKILLS_DIR = `${process.env.HOME ?? "/pihome"}/skills`;

interface PiResourcesApi {
  on(
    event: "resources_discover",
    handler: (event: { type: string; cwd: string; reason: string }) => Promise<{ skillPaths?: string[] }>,
  ): void;
}

export default function rosterSkills(api: PiResourcesApi): void {
  api.on("resources_discover", async () => {
    const { existsSync } = await import("node:fs");
    if (!existsSync(SKILLS_DIR)) return {};
    return { skillPaths: [SKILLS_DIR] };
  });
}
