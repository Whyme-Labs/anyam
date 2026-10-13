/** Keep inherited repository selectors, alternate objects, config injection,
 * credential helpers and tracing out of these owned local Git experiments. */
export function isolatedGitEnvironment(inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    const value = inherited[key]; if (value !== undefined) environment[key] = value;
  }
  const nullFile = process.platform === "win32" ? "NUL" : "/dev/null";
  return { ...environment, GIT_CONFIG_GLOBAL: nullFile, GIT_CONFIG_SYSTEM: nullFile, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" };
}
