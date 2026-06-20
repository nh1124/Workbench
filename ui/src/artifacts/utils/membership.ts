export function shouldReloadArtifactMemberships(
  operationItemId: string,
  currentItemId: string | null,
  isMounted: boolean
): boolean {
  return isMounted && operationItemId === currentItemId;
}
