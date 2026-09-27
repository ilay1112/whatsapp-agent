// EXPECT no-restricted-syntax x2 : non-literal dynamic import() is banned in src/main
export async function load(name: string): Promise<unknown> {
  const a = await import(name);
  const b = await import(`./plugins/${name}`);
  return [a, b];
}
