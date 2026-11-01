import {
  context,
  createRegistry,
  MemoryArtifacts,
  makeBaseline,
  makeSpecialistFixture,
  routingRequest,
} from "../helpers";

const rootDir = process.argv[2];
if (!rootDir) throw new Error("root directory argument required");

const artifacts = new MemoryArtifacts();
const fixture = await makeSpecialistFixture(artifacts, {
  specialistId: "fresh-process-specialist",
});
const registry = createRegistry(rootDir, artifacts);
await registry.registerBaseline(context, makeBaseline());
await registry.registerSpecialist(context, fixture.registration);
await registry.promote(context, "fresh-process-specialist", "1", null);
const decision = await registry.route(context, routingRequest());
const inspection = await registry.inspect(context, "fresh-process-specialist");
process.stdout.write(
  JSON.stringify({
    registration: fixture.registration,
    reportBytes: [...fixture.reportBytes],
    pointer: inspection.pointer,
    decision_sha256: decision.decision_sha256,
  }),
);
registry.close();
