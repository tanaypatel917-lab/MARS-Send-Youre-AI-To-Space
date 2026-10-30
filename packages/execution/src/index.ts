import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  Settings,
} from "@oh-my-pi/pi-coding-agent";
import { grep } from "@oh-my-pi/pi-natives";

export const EXECUTION_PACKAGE_VERSION = "18.14.0";

export interface ExecutionProbe {
  runtime: "oh-my-pi";
  package_version: string;
  session_initialized: boolean;
  executable_tools: string[];
  persistent_session: boolean;
  native_search_matches: number;
  model_requests: 0;
}

export async function probeExecution(): Promise<ExecutionProbe> {
  const fixture = await mkdtemp(join(tmpdir(), "mars-runtime-probe-"));
  const authStorage = await AuthStorage.create(":memory:");
  try {
    const marker = join(fixture, "probe.txt");
    await Bun.write(marker, "mars-native-probe\n");
    const nativeResult = await grep({
      pattern: "mars-native-probe",
      path: marker,
    });
    const { session } = await createAgentSession({
      cwd: fixture,
      agentDir: join(fixture, "agent"),
      authStorage,
      modelRegistry: new ModelRegistry(authStorage),
      getApiKey: async () => undefined,
      settings: Settings.isolated(),
      sessionManager: SessionManager.inMemory(),
      hasUI: false,
      disableExtensionDiscovery: true,
      skills: [],
      rules: [],
      contextFiles: [],
      noContextFiles: true,
      promptTemplates: [],
      slashCommands: [],
      toolNames: [],
      restrictToolNames: true,
      enableMCP: false,
      enableLsp: false,
      enableIrc: false,
      skipPythonPreflight: true,
      cacheWarming: false,
    });
    try {
      const tools = session.getActiveToolNames();
      if (tools.length !== 0)
        throw new Error("Probe unexpectedly enabled tools");
      if (session.sessionFile !== undefined)
        throw new Error("Probe persisted a session");
      if (nativeResult.matches.length !== 1)
        throw new Error("Native search probe failed");
      return {
        runtime: "oh-my-pi",
        package_version: EXECUTION_PACKAGE_VERSION,
        session_initialized: true,
        executable_tools: tools,
        persistent_session: false,
        native_search_matches: nativeResult.matches.length,
        model_requests: 0,
      };
    } finally {
      await session.dispose();
    }
  } finally {
    await authStorage.close();
    await rm(fixture, { recursive: true, force: true });
  }
}
