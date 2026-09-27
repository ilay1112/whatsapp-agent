// EXPECT no-restricted-syntax x3 : physical Tailwind classes are banned in src/renderer (use ms-/me-/ps-/pe-/start-/end-/text-start/text-end)
export function Bad({ on }: { on: boolean }) {
  const cls = `p-2 ${on ? 'pl-4' : ''}`;
  return (
    <div className="ml-4 text-left">
      <span className="right-0">x</span>
      <b className={cls}>y</b>
    </div>
  );
}
