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
    serving: [
      {
        model_id: "specialist-model",
        provider_id: "local",
        provider_model: "specialist-upstream",
        adapter_format: null,
      },
      {
        model_id: "specialist-model-2",
        provider_id: "local",
        provider_model: "specialist-upstream-2",
        adapter_format: null,
      },
    ],
  });
  return {
    label: SYNTHETIC_FIXTURE_NOTICE,
    worker,
    reviewer,
  };
}
