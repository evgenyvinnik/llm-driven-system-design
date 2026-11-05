export function homeFor(role: string | undefined): string {
  return role === 'yard' ? '/yard' : '/alerts'
}
