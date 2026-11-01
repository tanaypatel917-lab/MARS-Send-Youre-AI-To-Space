import {
  type MemoryArtifacts,
  makeSpecialistFixture,
  SYNTHETIC_FIXTURE_NOTICE,
} from "../helpers";

export async function makeSyntheticTeamFixture(artifacts: MemoryArtifacts) {
  const worker = await makeSpecialistFixture(artifacts, {
    specialistId: "team-worker",
    roles: ["worker"],
  });
  const reviewer = await makeSpecialistFixture(artifacts, {
    specialistId: "team-reviewer",
    roles: ["reviewer"],
    modelId: "specialist-model",
    providerModel: "specialist-upstream",
  });
  return {
    label: SYNTHETIC_FIXTURE_NOTICE,
    worker,
    reviewer,
  };
}
