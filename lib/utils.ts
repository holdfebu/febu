// Minimal class-name joiner (this project doesn't use Tailwind).
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
