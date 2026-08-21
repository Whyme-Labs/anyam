import { env } from "node:process";

/** Git options for broker-side inspection; repository-controlled hooks/config must not execute. */
export const TRUSTED_GIT_OPTIONS = [
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "protocol.ext.allow=never",
  "-c", "core.sshCommand=false",
] as const;

export function trustedGitArgs(args: readonly string[]): readonly string[] {
  return [...TRUSTED_GIT_OPTIONS, ...args];
}

export function trustedGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}
