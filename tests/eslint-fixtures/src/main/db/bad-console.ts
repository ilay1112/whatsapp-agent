// EXPECT no-console : console.* is banned in src/main
export function log(): void {
  console.log('x');
}
