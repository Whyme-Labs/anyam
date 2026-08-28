export const ANYAM_GITHUB_APP_QUALIFICATION_SCOPE = "qualification.github-app" as const;
export const ANYAM_GITHUB_APP_QUALIFICATION_PROTOCOL = "anyam.github-app-qualification-capability/v1" as const;
export const ANYAM_GITHUB_APP_QUALIFICATION_PATH = "/mcp/qualification/github-app" as const;

export type AnyamGitHubAppQualificationOperation =
  | "authority.state.inspect"
  | "authority.project.inspect"
  | "authority.project.create"
  | "authority.workspace.create"
  | "authority.mirror.inspect"
  | "authority.mirror.configure"
  | "authority.mirror.mutate"
  | "authority.recovery.export"
  | "authority.recovery.restore"
  | "authority.recovery.activate";
