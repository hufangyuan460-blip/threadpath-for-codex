/** Frozen at build time; packaged apps never need Git on the user's computer. */
export interface BuildInfo {
  readonly version: string;
  readonly commit: string | null;
  readonly dirty: boolean;
  readonly tag: string | null;
}
