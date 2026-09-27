// EXPECT no-restricted-syntax x4 : dangerouslySetInnerHTML / innerHTML / outerHTML / insertAdjacentHTML are banned
export function Bad({ html }: { html: string }) {
  const el = document.createElement('div');
  el.innerHTML = html;
  el.insertAdjacentHTML('beforeend', html);
  const s = el.outerHTML;
  return <div dangerouslySetInnerHTML={{ __html: s }} />;
}
