import { SkillStore } from "../store";

const [root, name] = process.argv.slice(2);
if (!root || !name) throw new Error("usage: child.ts <root> <name>");
await new SkillStore(root).create(
  name,
  `---\nname: ${name}\ndescription: A useful skill\n---\nInstructions`,
  { actor: name, source: "child" },
);
